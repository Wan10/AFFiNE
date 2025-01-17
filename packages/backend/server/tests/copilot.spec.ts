/// <reference types="../src/global.d.ts" />

import { TestingModule } from '@nestjs/testing';
import type { TestFn } from 'ava';
import ava from 'ava';

import { AuthService } from '../src/core/auth';
import { QuotaModule } from '../src/core/quota';
import { ConfigModule } from '../src/fundamentals/config';
import { CopilotModule } from '../src/plugins/copilot';
import { PromptService } from '../src/plugins/copilot/prompt';
import {
  CopilotProviderService,
  registerCopilotProvider,
} from '../src/plugins/copilot/providers';
import { ChatSessionService } from '../src/plugins/copilot/session';
import {
  CopilotCapability,
  CopilotProviderType,
} from '../src/plugins/copilot/types';
import { createTestingModule } from './utils';
import { MockCopilotTestProvider } from './utils/copilot';

const test = ava as TestFn<{
  auth: AuthService;
  module: TestingModule;
  prompt: PromptService;
  provider: CopilotProviderService;
  session: ChatSessionService;
}>;

test.beforeEach(async t => {
  const module = await createTestingModule({
    imports: [
      ConfigModule.forRoot({
        plugins: {
          copilot: {
            openai: {
              apiKey: '1',
            },
            fal: {
              apiKey: '1',
            },
          },
        },
      }),
      QuotaModule,
      CopilotModule,
    ],
  });

  const auth = module.get(AuthService);
  const prompt = module.get(PromptService);
  const provider = module.get(CopilotProviderService);
  const session = module.get(ChatSessionService);

  t.context.module = module;
  t.context.auth = auth;
  t.context.prompt = prompt;
  t.context.provider = provider;
  t.context.session = session;
});

test.afterEach.always(async t => {
  await t.context.module.close();
});

let userId: string;
test.beforeEach(async t => {
  const { auth } = t.context;
  const user = await auth.signUp('test', 'darksky@affine.pro', '123456');
  userId = user.id;
});

// ==================== prompt ====================

test('should be able to manage prompt', async t => {
  const { prompt } = t.context;

  t.is((await prompt.list()).length, 0, 'should have no prompt');

  await prompt.set('test', 'test', [
    { role: 'system', content: 'hello' },
    { role: 'user', content: 'hello' },
  ]);
  t.is((await prompt.list()).length, 1, 'should have one prompt');
  t.is(
    (await prompt.get('test'))!.finish({}).length,
    2,
    'should have two messages'
  );

  await prompt.update('test', [{ role: 'system', content: 'hello' }]);
  t.is(
    (await prompt.get('test'))!.finish({}).length,
    1,
    'should have one message'
  );

  await prompt.delete('test');
  t.is((await prompt.list()).length, 0, 'should have no prompt');
  t.is(await prompt.get('test'), null, 'should not have the prompt');
});

test('should be able to render prompt', async t => {
  const { prompt } = t.context;

  const msg = {
    role: 'system' as const,
    content: 'translate {{src_language}} to {{dest_language}}: {{content}}',
    params: { src_language: ['eng'], dest_language: ['chs', 'jpn', 'kor'] },
  };
  const params = {
    src_language: 'eng',
    dest_language: 'chs',
    content: 'hello world',
  };

  await prompt.set('test', 'test', [msg]);
  const testPrompt = await prompt.get('test');
  t.assert(testPrompt, 'should have prompt');
  t.is(
    testPrompt?.finish(params).pop()?.content,
    'translate eng to chs: hello world',
    'should render the prompt'
  );
  t.deepEqual(
    testPrompt?.paramKeys,
    Object.keys(params),
    'should have param keys'
  );
  t.deepEqual(testPrompt?.params, msg.params, 'should have params');
  // will use first option if a params not provided
  t.deepEqual(testPrompt?.finish({ src_language: 'abc' }), [
    {
      content: 'translate eng to chs: ',
      params: { dest_language: 'chs', src_language: 'eng' },
      role: 'system',
    },
  ]);
});

test('should be able to render listed prompt', async t => {
  const { prompt } = t.context;

  const msg = {
    role: 'system' as const,
    content: 'links:\n{{#links}}- {{.}}\n{{/links}}',
  };
  const params = {
    links: ['https://affine.pro', 'https://github.com/toeverything/affine'],
  };

  await prompt.set('test', 'test', [msg]);
  const testPrompt = await prompt.get('test');

  t.is(
    testPrompt?.finish(params).pop()?.content,
    'links:\n- https://affine.pro\n- https://github.com/toeverything/affine\n',
    'should render the prompt'
  );
});

// ==================== session ====================

test('should be able to manage chat session', async t => {
  const { prompt, session } = t.context;

  await prompt.set('prompt', 'model', [
    { role: 'system', content: 'hello {{word}}' },
  ]);

  const sessionId = await session.create({
    docId: 'test',
    workspaceId: 'test',
    userId,
    promptName: 'prompt',
  });
  t.truthy(sessionId, 'should create session');

  const s = (await session.get(sessionId))!;
  t.is(s.config.sessionId, sessionId, 'should get session');
  t.is(s.config.promptName, 'prompt', 'should have prompt name');
  t.is(s.model, 'model', 'should have model');

  const params = { word: 'world' };

  s.push({ role: 'user', content: 'hello', createdAt: new Date() });
  // @ts-expect-error
  const finalMessages = s.finish(params).map(({ createdAt: _, ...m }) => m);
  t.deepEqual(
    finalMessages,
    [
      { content: 'hello world', params, role: 'system' },
      { content: 'hello', role: 'user' },
    ],
    'should generate the final message'
  );
  await s.save();

  const s1 = (await session.get(sessionId))!;
  t.deepEqual(
    // @ts-expect-error
    s1.finish(params).map(({ createdAt: _, ...m }) => m),
    finalMessages,
    'should same as before message'
  );
  t.deepEqual(
    // @ts-expect-error
    s1.finish({}).map(({ createdAt: _, ...m }) => m),
    [
      { content: 'hello ', params: {}, role: 'system' },
      { content: 'hello', role: 'user' },
    ],
    'should generate different message with another params'
  );
});

test('should be able to process message id', async t => {
  const { prompt, session } = t.context;

  await prompt.set('prompt', 'model', [
    { role: 'system', content: 'hello {{word}}' },
  ]);

  const sessionId = await session.create({
    docId: 'test',
    workspaceId: 'test',
    userId,
    promptName: 'prompt',
  });
  const s = (await session.get(sessionId))!;

  const textMessage = (await session.createMessage({
    sessionId,
    content: 'hello',
  }))!;
  const anotherSessionMessage = (await session.createMessage({
    sessionId: 'another-session-id',
  }))!;

  await t.notThrowsAsync(
    s.pushByMessageId(textMessage),
    'should push by message id'
  );
  await t.throwsAsync(
    s.pushByMessageId(anotherSessionMessage),
    {
      instanceOf: Error,
    },
    'should throw error if push by another session message id'
  );
  await t.throwsAsync(
    s.pushByMessageId('invalid'),
    { instanceOf: Error },
    'should throw error if push by invalid message id'
  );
});

test('should be able to generate with message id', async t => {
  const { prompt, session } = t.context;

  await prompt.set('prompt', 'model', [
    { role: 'system', content: 'hello {{word}}' },
  ]);

  // text message
  {
    const sessionId = await session.create({
      docId: 'test',
      workspaceId: 'test',
      userId,
      promptName: 'prompt',
    });
    const s = (await session.get(sessionId))!;

    const message = (await session.createMessage({
      sessionId,
      content: 'hello',
    }))!;

    await s.pushByMessageId(message);
    const finalMessages = s
      .finish({ word: 'world' })
      .map(({ content }) => content);
    t.deepEqual(finalMessages, ['hello world', 'hello']);
  }

  // attachment message
  {
    const sessionId = await session.create({
      docId: 'test',
      workspaceId: 'test',
      userId,
      promptName: 'prompt',
    });
    const s = (await session.get(sessionId))!;

    const message = (await session.createMessage({
      sessionId,
      attachments: ['https://affine.pro/example.jpg'],
    }))!;

    await s.pushByMessageId(message);
    const finalMessages = s
      .finish({ word: 'world' })
      .map(({ attachments }) => attachments);
    t.deepEqual(finalMessages, [
      // system prompt
      undefined,
      // user prompt
      ['https://affine.pro/example.jpg'],
    ]);
  }

  // empty message
  {
    const sessionId = await session.create({
      docId: 'test',
      workspaceId: 'test',
      userId,
      promptName: 'prompt',
    });
    const s = (await session.get(sessionId))!;

    const message = (await session.createMessage({
      sessionId,
    }))!;

    await s.pushByMessageId(message);
    const finalMessages = s
      .finish({ word: 'world' })
      .map(({ content }) => content);
    // empty message should be filtered
    t.deepEqual(finalMessages, ['hello world']);
  }
});

test('should save message correctly', async t => {
  const { prompt, session } = t.context;

  await prompt.set('prompt', 'model', [
    { role: 'system', content: 'hello {{word}}' },
  ]);

  const sessionId = await session.create({
    docId: 'test',
    workspaceId: 'test',
    userId,
    promptName: 'prompt',
  });
  const s = (await session.get(sessionId))!;

  const message = (await session.createMessage({
    sessionId,
    content: 'hello',
  }))!;

  await s.pushByMessageId(message);
  t.is(s.stashMessages.length, 1, 'should get stash messages');
  await s.save();
  t.is(s.stashMessages.length, 0, 'should empty stash messages after save');
});

// ==================== provider ====================

test('should be able to get provider', async t => {
  const { provider } = t.context;

  {
    const p = provider.getProviderByCapability(CopilotCapability.TextToText);
    t.is(
      p?.type.toString(),
      'openai',
      'should get provider support text-to-text'
    );
  }

  {
    const p = provider.getProviderByCapability(
      CopilotCapability.TextToEmbedding
    );
    t.is(
      p?.type.toString(),
      'openai',
      'should get provider support text-to-embedding'
    );
  }

  {
    const p = provider.getProviderByCapability(CopilotCapability.TextToImage);
    t.is(
      p?.type.toString(),
      'fal',
      'should get provider support text-to-image'
    );
  }

  {
    const p = provider.getProviderByCapability(CopilotCapability.ImageToImage);
    t.is(
      p?.type.toString(),
      'fal',
      'should get provider support image-to-image'
    );
  }

  {
    const p = provider.getProviderByCapability(CopilotCapability.ImageToText);
    t.is(
      p?.type.toString(),
      'openai',
      'should get provider support image-to-text'
    );
  }

  // text-to-image use fal by default, but this case can use
  // model dall-e-3 to select openai provider
  {
    const p = provider.getProviderByCapability(
      CopilotCapability.TextToImage,
      'dall-e-3'
    );
    t.is(
      p?.type.toString(),
      'openai',
      'should get provider support text-to-image and model'
    );
  }
});

test('should be able to register test provider', async t => {
  const { provider } = t.context;
  registerCopilotProvider(MockCopilotTestProvider);

  const assertProvider = (cap: CopilotCapability) => {
    const p = provider.getProviderByCapability(cap, 'test');
    t.is(
      p?.type,
      CopilotProviderType.Test,
      `should get test provider with ${cap}`
    );
  };

  assertProvider(CopilotCapability.TextToText);
  assertProvider(CopilotCapability.TextToEmbedding);
  assertProvider(CopilotCapability.TextToImage);
  assertProvider(CopilotCapability.ImageToImage);
  assertProvider(CopilotCapability.ImageToText);
});
