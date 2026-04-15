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
   * Streaming chat completion — yields content chunks
   */
  async *chatStream(messages, options = {}) {
    const url = `${this.endpoint}/chat/completions`;
    const body = {
      model: options.model || this.model,
      messages,
      stream: true,
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
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  }

  /**
   * Non-streaming chat — collects all chunks into one string
   */
  async chat(messages, options = {}) {
    const chunks = [];
    for await (const chunk of this.chatStream(messages, options)) {
      chunks.push(chunk);
    }
    return chunks.join('');
  }
}
