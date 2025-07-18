# Gemini CLI API 密钥池与负载均衡功能设计文档

## 1. 目标

为了解决 Gemini API 免费套餐的速率限制问题（例如每分钟请求数限制），本项目旨在为 Gemini CLI 添加一个 API 密钥池（API Key Pool）功能。当用户提供多个 API 密钥时，CLI 工具应能以轮询（Round-Robin）的方式在每次 API 请求时使用不同的密钥，从而实现负载均衡，提高工具的吞吐量和稳定性。

## 2. 总体策略

我们将采用分层的方式实现此功能，尽量减少对现有代码的侵入性，并保持良好的模块化设计。

1.  **配置层增强**: 修改配置加载逻辑，使其能够识别并解析一个包含多个 API 密钥的来源。
2.  **核心逻辑实现**: 在 `packages/core` 中创建一个独立的 `ApiKeyManager` 服务，该服务作为单例存在，负责管理密钥池和轮询逻辑。
3.  **API 调用集成**: 修改发起 Gemini API 请求的地方，使其不再直接从配置中取固定的密钥，而是向 `ApiKeyManager` 请求下一个可用的密钥。
4.  **用户体验优化**: 在 CLI 启动时向用户明确提示当前已启用密钥池模式，增加透明度。

---

## 3. 详细实现步骤

### 步骤一：配置��设计 (`packages/cli`)

我们需要确定用户如何向 CLI 提供多个 API 密钥。

**主要文件**: `packages/cli/src/config/config.ts`, `packages/cli/src/config/auth.ts`, `packages/cli/src/gemini.tsx`

**技术节点与建议**:

- **方案 A (推荐): 使用环境变量**
  - **实现**: 定义一个新的环境变量，如 `GEMINI_API_KEY_POOL`。用户可以像这样设置它：
    ```bash
    export GEMINI_API_KEY_POOL="key_1,key_2,key_3"
    ```
  - **优点**:
    - 这是 CLI 工具的标准实践，易于在不同环境（本地、CI/CD）中配置。
    - 无需修改配置文件，对现有用户无影响。
    - 安全性较高，密钥不会被意外提交到版本控制中。
  - **逻辑**:
    1.  在 `config.ts` 中，优先检查 `process.env.GEMINI_API_KEY_POOL`。
    2.  如果存在，则通过 `split(',')` 将其解析为一个字符串数组。
    3.  如果不存在，则回退到检查现有的 `process.env.GEMINI_API_KEY`，并将其作为一个单元素的数组。
    4.  将这个密钥数组（`string[]`）存储在全局配置对象中，例如 `config.apiKeys`。
    5.  在 `auth.ts` 和 `gemini.tsx` 中，修改启动时的身份验证检查逻辑，使其在验证 Gemini API 密钥时，同时识别 `GEMINI_API_KEY` 和 `GEMINI_API_KEY_POOL`。

- **方案 B: 使用配置文件**
  - **实现**: 在 `.gemini/config.json` 或类似文件中支持一个新的字段。
    ```json
    {
      "apiKeys": ["key_1", "key_2", "key_3"]
    }
    ```
  - **优点**: 对用户来说，编辑一个 JSON 文件可能比管理一个长长的环境变量字符串更方便。
  - **缺点**: 增加了文件 I/O 的复杂性，且用户可能不小心将包含密钥的配置文件提交到 Git。

- **决策**: 我们将首先实现 **方案 A**，因为它更简单、更安全，也符合 CLI 工具的普遍做法。未来可以考虑同时支持方案 B，并定义优先级（例如，环境变量覆盖配置文件）。

### 步骤二：实现 `ApiKeyManager` (`packages/core`)

这是功能的核心，负责管理密钥状态。

**新建文件**: `packages/core/src/services/ApiKeyManager.ts`

```typescript
// packages/core/src/services/ApiKeyManager.ts

class ApiKeyManager {
  private keys: string[] = [];
  private currentIndex = 0;

  /**
   * 使用从配置中加载的密钥数组初始化管理器。
   * 这个方法应该在应用启动时被调用一次。
   */
  public init(keys: string[]): void {
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
  public getNextKey(): string | null {
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
  public getPoolSize(): number {
    return this.keys.length;
  }
}

// 导出一个单例，确保整个应用的生命周期中只有一个实例
export const apiKeyManager = new ApiKeyManager();
```

**技术节点与建议**:

- **状态管理**:
  - **方案 A (推荐): 导出单例**。如上所示，创建一个类的实例并导出。这是最简单直接的方式，足以满足 CLI 应用的需求。
  - **方案 B: 依赖注入**。如果项目未来引入了依赖注入容器，可以将 `ApiKeyManager` 注册为单例服务。目前来看，这有些过度设计。

- **初始化**:
  - 在 CLI 启动的早期阶段，例如在 `packages/cli/src/gemini.tsx` 或主入口文件中，一旦配置加载完毕，就立即调用 `apiKeyManager.init(config.apiKeys)`。

### 步骤三：集成到 API 调用流程 (`packages/core`)

现在，我们需要找到实际创建 `GoogleGenerativeAI` 客户端的地方，并使用我们的管理器。

**可能的文件**: `packages/core/src/services/GeminiService.ts` (或类似文件)

**修改前 (示意)**:

```typescript
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getConfig } from '../config'; // 假设有这个函数

const config = getConfig();
const genAI = new GoogleGenerativeAI(config.apiKey);
// ...
```

**修改后 (示意)**:

```typescript
import { GoogleGenerativeAI } from '@google/generative-ai';
import { apiKeyManager } from './ApiKeyManager';

// ... 在需要发起 API 请求的函数内部 ...
async function someFunctionThatMakesApiCall() {
  const apiKey = apiKeyManager.getNextKey();
  if (!apiKey) {
    throw new Error('No API key available. Please check your configuration.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // ... 后续逻辑不变
}
```

**技术节点与建议 (错误处理与重试)**:

- **方案 A (基础): 失败即报错**。如果一个密钥因为速率限制而失败，请求就会失败。用户需要等待下一分钟。
- **方案 B (推荐): 自动重试**。我们可以让 API 调用逻辑更智能。
  - **实现**:
    1.  将 API 调用包在 `try...catch` 块中。
    2.  如果 `catch` 到的错误是速率限制错误（通常 API 会返回特定的错误码或消息，例如 429 Too Many Requests），则调用 `apiKeyManager.getNextKey()` 获取下一个密钥并重试。
    3.  为了防止无限循环（例如，所有密钥都已达到限额），需要设置一个重试次数上限，最多不超过密钥池的大小。
  - **优点**: 极大提升用户体验，使工具更具弹性。

### 步骤四：用户界面提示 (`packages/cli`)

**主要文件**: `packages/cli/src/ui/App.tsx`

在应用启动时，检查密钥池的大小，并给用户一个明确的反馈。

```typescript
// 在 App.tsx 的某个地方，组件挂载后
import { apiKeyManager } from '@gemini-cli/core'; // 假设 core 包的入口导出了它

// ...
useEffect(() => {
  const poolSize = apiKeyManager.getPoolSize();
  if (poolSize > 1) {
    console.log(
      `[INFO] Detected ${poolSize} API keys. API polling is enabled.`,
    );
  }
}, []);
// ...
```

---

## 4. 文件修改清单

- **修改**: `packages/cli/src/config/config.ts` (或 `auth.ts`) - 添加对 `GEMINI_API_KEY_POOL` 的解析。
- **新建**: `packages/core/src/services/ApiKeyManager.ts` - 实现密钥池和轮询逻辑。
- **修改**: `packages/core/src/services/GeminiService.ts` (或实际进行 API 调用的文件) - 集成 `ApiKeyManager`，替换静态的密钥获取方式。
- **修改**: `packages/cli/src/gemini.tsx` (或主入口文件) - 调用 `apiKeyManager.init()` 并添加 UI 提示。

## 5. 测试策略

1.  **单元测试**: 为 `ApiKeyManager` 编写单元测试，确保 `getNextKey` 的轮询逻辑正确无误，并且在密钥池为空或只有一个密钥时行为符合预期。
2.  **集成测试**:
    - 编写一个新的集成测试用例。
    - 在测试中，使用 `mock-fs` 或类似工具模拟环境变量 `GEMINI_API_KEY_POOL`。
    - Spy (监视) `GoogleGenerativeAI` 的构造函数。
    - 模拟多次 API 调用，并断言 `GoogleGenerativeAI` 的构造函数被依次传入了池中的不同密钥。

---

此设计方案提供了一个完整、健壮且可扩展的实现路径。如果批准此计划，我将开始创建和修改相应的文件。
