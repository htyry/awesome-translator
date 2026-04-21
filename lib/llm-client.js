// OpenAI-compatible LLM client with streaming support

export class LLMClient {
  constructor(config = {}) {
    this.endpoint = (config.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o-mini';
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature ?? 0.3;
  }

  getConfig() {
    return {
      endpoint: this.endpoint,
      model: this.model,
      hasApiKey: !!this.apiKey,
    };
  }

  /**
   * Streaming chat completion — yields content chunks.
   * If options.onUsage is provided, it will be called with the usage object
   * from the final SSE chunk (OpenAI-compatible API returns usage in stream_options or last chunk).
   */
  async *chatStream(messages, options = {}) {
    const url = `${this.endpoint}/chat/completions`;
    const body = {
      model: options.model || this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));

          // Extract usage from any chunk that contains it
          if (json.usage) {
            lastUsage = json.usage;
          }

          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    // Deliver usage info after streaming completes
    if (lastUsage && options.onUsage) {
      options.onUsage(lastUsage);
    }
  }

  /**
   * Non-streaming chat — collects all chunks into one string.
   * Returns { content, usage } where usage contains token counts if available.
   */
  async chat(messages, options = {}) {
    let usage = null;
    const chunks = [];
    for await (const chunk of this.chatStream(messages, {
      ...options,
      onUsage: (u) => { usage = u; },
    })) {
      chunks.push(chunk);
    }
    return { content: chunks.join(''), usage };
  }
}
