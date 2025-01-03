/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Registry } from '@genkit-ai/core/registry';
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { DocumentData } from '../../src/document.js';
import { configureFormats } from '../../src/formats/index.js';
import {
  GenerateRequest,
  GenerateResponseData,
  MessageData,
  defineModel,
} from '../../src/model.js';
import {
  AugmentWithContextOptions,
  CONTEXT_PREFACE,
  augmentWithContext,
  simulateSystemPrompt,
  validateSupport,
} from '../../src/model/middleware.js';

describe('validateSupport', () => {
  const examples: Record<string, GenerateRequest> = {
    multiturn: {
      messages: [
        { role: 'user', content: [{ text: 'hello' }] },
        { role: 'model', content: [{ text: 'hi' }] },
        { role: 'user', content: [{ text: 'how are you' }] },
      ],
    },
    media: {
      messages: [
        {
          role: 'user',
          content: [{ media: { url: 'https://example.com/image.png' } }],
        },
      ],
    },
    tools: {
      messages: [
        {
          role: 'user',
          content: [{ media: { url: 'https://example.com/image.png' } }],
        },
      ],
      tools: [
        {
          name: 'someTool',
          description: 'hello world',
          inputSchema: { type: 'object' },
        },
      ],
    },
    json: {
      messages: [
        {
          role: 'user',
          content: [{ text: 'hello world' }],
        },
      ],
      output: { format: 'json' },
    },
  };

  let nextCalled = false;
  const noopNext: (
    req?: GenerateRequest
  ) => Promise<GenerateResponseData> = async () => {
    nextCalled = true;
    return {};
  };
  beforeEach(() => (nextCalled = false));

  it('accepts anything when no supports is present', () => {
    const runner = validateSupport({ name: 'test-model' });
    for (const example of Object.values(examples)) {
      runner(example, noopNext);
    }
    assert(nextCalled, "next() wasn't called");
  });

  it('throws when media is supplied but not supported', async () => {
    const runner = validateSupport({
      name: 'test-model',
      supports: {
        media: false,
      },
    });
    await assert.rejects(
      runner(examples.media, noopNext),
      /does not support media/
    );
  });

  it('throws when tools are supplied but not supported', async () => {
    const runner = validateSupport({
      name: 'test-model',
      supports: {
        tools: false,
      },
    });
    await assert.rejects(
      runner(examples.tools, noopNext),
      /does not support tool use/
    );
  });

  it('throws when multiturn messages are supplied but not supported', async () => {
    const runner = validateSupport({
      name: 'test-model',
      supports: {
        multiturn: false,
      },
    });
    await assert.rejects(
      runner(examples.multiturn, noopNext),
      /does not support multiple messages/
    );
  });
});

const registry = new Registry();
configureFormats(registry);

const echoModel = defineModel(registry, { name: 'echo' }, async (req) => {
  return {
    finishReason: 'stop',
    message: {
      role: 'model',
      content: [{ data: req }],
    },
  };
});

describe('simulateSystemPrompt', () => {
  function testRequest(
    req: GenerateRequest,
    options?: Parameters<typeof simulateSystemPrompt>[0]
  ) {
    return new Promise((resolve, reject) => {
      simulateSystemPrompt(options)(req, resolve as any);
    });
  }

  it('does not modify a request with no system prompt', async () => {
    const req: GenerateRequest = {
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
    };
    assert.deepEqual(await testRequest(req), req);
  });

  it('keeps other messages in place', async () => {
    const req: GenerateRequest = {
      messages: [
        { role: 'system', content: [{ text: 'I am a system message' }] },
        { role: 'user', content: [{ text: 'hello' }] },
      ],
    };
    assert.deepEqual(await testRequest(req), {
      messages: [
        {
          role: 'user',
          content: [
            { text: 'SYSTEM INSTRUCTIONS:\n' },
            { text: 'I am a system message' },
          ],
        },
        {
          role: 'model',
          content: [{ text: 'Understood.' }],
        },
        {
          role: 'user',
          content: [{ text: 'hello' }],
        },
      ],
    });
  });
});

describe('augmentWithContext', () => {
  async function testRequest(
    messages: MessageData[],
    context?: DocumentData[],
    options?: AugmentWithContextOptions
  ) {
    const changedRequest = await new Promise<GenerateRequest>(
      (resolve, reject) => {
        augmentWithContext(options)(
          {
            messages,
            docs: context,
          },
          resolve as any
        );
      }
    );
    return changedRequest.messages;
  }

  it('should not change a message with empty context', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    assert.deepEqual(await testRequest(messages, undefined), messages);
    assert.deepEqual(await testRequest(messages, []), messages);
  });

  it('should not change a message that already has a context part with content', async () => {
    const messages: MessageData[] = [
      {
        role: 'user',
        content: [{ text: 'first part', metadata: { purpose: 'context' } }],
      },
    ];
    assert.deepEqual(
      await testRequest(messages, [{ content: [{ text: 'i am context' }] }]),
      messages
    );
  });

  it('should augment a message that has a pending context part', async () => {
    const messages: MessageData[] = [
      {
        role: 'user',
        content: [{ metadata: { purpose: 'context', pending: true } }],
      },
    ];
    assert.deepEqual(
      await testRequest(messages, [{ content: [{ text: 'i am context' }] }]),
      [
        {
          content: [
            {
              metadata: {
                purpose: 'context',
              },
              text: `${CONTEXT_PREFACE}- [0]: i am context\n\n`,
            },
          ],
          role: 'user',
        },
      ]
    );
  });

  it('should append a new text part', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(messages, [
      { content: [{ text: 'i am context' }] },
      { content: [{ text: 'i am more context' }] },
    ]);
    assert.deepEqual(result[0].content.at(-1), {
      text: `${CONTEXT_PREFACE}- [0]: i am context\n- [1]: i am more context\n\n`,
      metadata: { purpose: 'context' },
    });
  });

  it('should append to the last user message', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
      {
        role: 'tool',
        content: [{ toolResponse: { name: 'testTool', output: { abc: 123 } } }],
      },
    ];
    const result = await testRequest(messages, [
      { content: [{ text: 'i am context' }] },
      { content: [{ text: 'i am more context' }] },
    ]);
    assert.deepEqual(result[0].content.at(-1), {
      text: `${CONTEXT_PREFACE}- [0]: i am context\n- [1]: i am more context\n\n`,
      metadata: { purpose: 'context' },
    });
  });

  it('should use a custom preface', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(
      messages,
      [
        { content: [{ text: 'i am context' }] },
        { content: [{ text: 'i am more context' }] },
      ],
      { preface: '\n\nCheck this out:\n\n' }
    );
    assert.deepEqual(result[0].content.at(-1), {
      text: '\n\nCheck this out:\n\n- [0]: i am context\n- [1]: i am more context\n\n',
      metadata: { purpose: 'context' },
    });
  });

  it('should elide a null preface', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(
      messages,
      [
        { content: [{ text: 'i am context' }] },
        { content: [{ text: 'i am more context' }] },
      ],
      { preface: null }
    );
    assert.deepEqual(result[0].content.at(-1), {
      text: '- [0]: i am context\n- [1]: i am more context\n\n',
      metadata: { purpose: 'context' },
    });
  });

  it('should use a citationKey', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(
      messages,
      [
        { content: [{ text: 'i am context' }], metadata: { uid: 'first' } },
        {
          content: [{ text: 'i am more context' }],
          metadata: { uid: 'second' },
        },
      ],
      { citationKey: 'uid' }
    );
    assert.deepEqual(result[0].content.at(-1), {
      text: `${CONTEXT_PREFACE}- [first]: i am context\n- [second]: i am more context\n\n`,
      metadata: { purpose: 'context' },
    });
  });

  it('should use "ref", "id", and index, in that order, if citationKey is unspecified', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(messages, [
      {
        content: [{ text: 'i am context' }],
        metadata: { ref: 'first', id: 'wrong' },
      },
      {
        content: [{ text: 'i am more context' }],
        metadata: { id: 'second' },
      },
      {
        content: [{ text: 'i am even more context' }],
      },
    ]);
    assert.deepEqual(result[0].content.at(-1), {
      text: `${CONTEXT_PREFACE}- [first]: i am context\n- [second]: i am more context\n- [2]: i am even more context\n\n`,
      metadata: { purpose: 'context' },
    });
  });

  it('should use a custom itemTemplate', async () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'first part' }] },
    ];
    const result = await testRequest(
      messages,
      [
        { content: [{ text: 'i am context' }], metadata: { uid: 'first' } },
        {
          content: [{ text: 'i am more context' }],
          metadata: { uid: 'second' },
        },
      ],
      { itemTemplate: (d) => `* (${d.metadata!.uid}) -- ${d.text}\n` }
    );
    assert.deepEqual(result[0].content.at(-1), {
      text: `${CONTEXT_PREFACE}* (first) -- i am context\n* (second) -- i am more context\n\n`,
      metadata: { purpose: 'context' },
    });
  });
});
