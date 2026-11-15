// The local llama.cpp server as a pi-ai provider.
//
// pi the CLI reads ~/.pi/agent/models.json. pi-durable is a library, so there is no
// config file to read: the provider is built here with the same values. `createProvider`
// is the same entry point pi's own models.json loader goes through.

import { createProvider } from "@earendil-works/pi-ai/models"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import type { Provider } from "@earendil-works/pi-ai/models"

export const PROVIDER_ID = "llama"
export const BASE_URL = process.env.SHOP_LLAMA_BASE_URL ?? "http://127.0.0.1:8080/v1"
export const MODEL_ID = process.env.SHOP_MODEL_ID ?? "qwen3.5-35b-a3b"

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The llama.cpp server. Keyless, so auth resolves a placeholder without touching the network. */
export function llamaProvider(): Provider {
  return createProvider({
    id: PROVIDER_ID,
    name: "llama.cpp (local)",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "llama.cpp (local, keyless)",
        resolve: async () => ({ auth: { apiKey: "local", baseUrl: BASE_URL }, source: "local server" }),
      },
    },
    models: [
      {
        id: MODEL_ID,
        name: "Qwen3.5 35B-A3B (local)",
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: BASE_URL,
        input: ["text"],
        cost: FREE,
        reasoning: true,
        // Matches the server's -c 49152 split across --parallel 2.
        contextWindow: 24576,
        maxTokens: 8192,
        samplingParams: { temperature: 0.7, top_p: 0.8, top_k: 20 },
      },
    ],
    api: openAICompletionsApi(),
  })
}

export const MODEL_REF = { provider: PROVIDER_ID, modelId: MODEL_ID }
