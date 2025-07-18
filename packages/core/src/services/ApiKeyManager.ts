/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// packages/core/src/services/ApiKeyManager.ts

class ApiKeyManager {
  private keys: string[] = [];
  private currentIndex = 0;

  /**
   * 使用从配置中加载的密钥数组初始化管理器。
   * 这个方法应该在应用启动时被调用一次。
   */
  init(keys: string[]): void {
    if (!keys || keys.length === 0) {
      console.warn('API key pool is empty. API calls may fail.');
      this.keys = [];
    } else {
      this.keys = keys.filter((k) => k.trim() !== ''); // 过滤掉空字符串
    }
    this.currentIndex = 0;
  }

  /**
   * 以轮询方式获取下一个 API 密钥。
   */
  getNextKey(): string | null {
    if (this.keys.length === 0) {
      return null;
    }
    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return key;
  }

  /**
   * 获取当前池中的密钥数量。
   */
  getPoolSize(): number {
    return this.keys.length;
  }
}

// 导出一个单例，确保整个应用的生命周期中只有一个实例
export const apiKeyManager = new ApiKeyManager();
