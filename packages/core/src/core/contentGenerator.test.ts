/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  createContentGenerator,
  AuthType,
  createContentGeneratorConfig,
} from './contentGenerator.js';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { GoogleGenAI } from '@google/genai';
import { Config } from '../config/config.js';
import { apiKeyManager } from '../services/ApiKeyManager.js';

vi.mock('../code_assist/codeAssist.js');
vi.mock('@google/genai');
vi.mock('../services/ApiKeyManager.js');

const mockConfig = {} as unknown as Config;

describe('createContentGenerator', () => {
  it('should create a CodeAssistContentGenerator', async () => {
    const mockGenerator = {} as unknown;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockGenerator as never,
    );
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        authType: AuthType.LOGIN_WITH_GOOGLE,
      },
      mockConfig,
    );
    expect(createCodeAssistContentGenerator).toHaveBeenCalled();
    expect(generator).toBe(mockGenerator);
  });

  it('should create a GoogleGenAI content generator', async () => {
    const mockGenerator = {
      models: {},
    } as unknown;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.mocked(apiKeyManager.getNextKey).mockReturnValue('test-api-key');
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
        },
      },
    });
    expect(generator).toBe((mockGenerator as GoogleGenAI).models);
  });
});

describe('createContentGeneratorConfig', () => {
  const originalEnv = process.env;
  const mockConfig = {
    getModel: vi.fn().mockReturnValue('gemini-pro'),
    setModel: vi.fn(),
    flashFallbackHandler: vi.fn(),
  } as unknown as Config;

  beforeEach(() => {
    // Reset modules to re-evaluate imports and environment variables
    vi.resetModules();
    // Restore process.env before each test
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterAll(() => {
    // Restore original process.env after all tests
    process.env = originalEnv;
  });

  it('should configure for Gemini using GEMINI_API_KEY when set', async () => {
    process.env.GEMINI_API_KEY = 'env-gemini-key';
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_GEMINI,
    );
    expect(config.apiKey).toBe('env-gemini-key');
    expect(config.vertexai).toBe(false);
  });

  it('should not configure for Gemini if GEMINI_API_KEY is empty', async () => {
    process.env.GEMINI_API_KEY = '';
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_GEMINI,
    );
    expect(config.apiKey).toBeUndefined();
    expect(config.vertexai).toBeUndefined();
  });

  it('should configure for Vertex AI using GOOGLE_API_KEY when set', async () => {
    process.env.GOOGLE_API_KEY = 'env-google-key';
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_VERTEX_AI,
    );
    expect(config.apiKey).toBe('env-google-key');
    expect(config.vertexai).toBe(true);
  });

  it('should configure for Vertex AI using GCP project and location when set', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'env-gcp-project';
    process.env.GOOGLE_CLOUD_LOCATION = 'env-gcp-location';
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_VERTEX_AI,
    );
    expect(config.vertexai).toBe(true);
    expect(config.apiKey).toBeUndefined();
  });

  it('should not configure for Vertex AI if required env vars are empty', async () => {
    process.env.GOOGLE_API_KEY = '';
    process.env.GOOGLE_CLOUD_PROJECT = '';
    process.env.GOOGLE_CLOUD_LOCATION = '';
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_VERTEX_AI,
    );
    expect(config.apiKey).toBeUndefined();
    expect(config.vertexai).toBeUndefined();
  });
});

describe('API Key Pooling', () => {
  const mockConfig = {} as unknown as Config;

  beforeEach(() => {
    // 在每个测试前重置模拟，确保测试之间是独立的
    vi.clearAllMocks();
  });

  it('should use a different API key from the pool for each subsequent call', async () => {
    // 1. Arrange (准备)
    const keyPool = ['key-A', 'key-B', 'key-C'];
    
    // 模拟 getNextKey 方法，使其按顺序返回池中的密钥
    const getNextKeyMock = vi.fn()
      .mockReturnValueOnce(keyPool[0])
      .mockReturnValueOnce(keyPool[1])
      .mockReturnValueOnce(keyPool[2])
      .mockReturnValueOnce(keyPool[0]); // 第四次调用，循环回第一个

    vi.mocked(apiKeyManager.getNextKey).mockImplementation(getNextKeyMock);

    const contentGeneratorConfig = {
      model: 'test-model',
      authType: AuthType.USE_GEMINI,
    };

    // 2. Act (执行)
    // 连续调用四次 createContentGenerator 来模拟四次独立的 API 请求
    await createContentGenerator(contentGeneratorConfig, mockConfig);
    await createContentGenerator(contentGeneratorConfig, mockConfig);
    await createContentGenerator(contentGeneratorConfig, mockConfig);
    await createContentGenerator(contentGeneratorConfig, mockConfig);

    // 3. Assert (断言)
    // 验证 GoogleGenAI 的构造函数是否被正确调用了四次
    expect(GoogleGenAI).toHaveBeenCalledTimes(4);

    // 验证每一次调用时，传入的 apiKey 是否符合轮询顺序
    expect(vi.mocked(GoogleGenAI).mock.calls[0][0]).toEqual(
      expect.objectContaining({ apiKey: 'key-A' })
    );
    expect(vi.mocked(GoogleGenAI).mock.calls[1][0]).toEqual(
      expect.objectContaining({ apiKey: 'key-B' })
    );
    expect(vi.mocked(GoogleGenAI).mock.calls[2][0]).toEqual(
      expect.objectContaining({ apiKey: 'key-C' })
    );
    // 验证第四次调用时，密钥是否已循环回第一个
    expect(vi.mocked(GoogleGenAI).mock.calls[3][0]).toEqual(
      expect.objectContaining({ apiKey: 'key-A' })
    );
  });
});