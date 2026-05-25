// OpenAI-compatible LLM client with streaming support

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Determine if an error is transient and worth retrying */
function isRetryableError(error) {
  if (error.name === 'AbortError') {
    // Distinguish our timeout abort from user-initiated abort
    return error._timeout === true;
  }
  if (error instanceof TypeError) {
    // Network errors (fetch failed, DNS, CORS, etc.)
    return true;
  }
  return false;
}

/** Determine if an HTTP status is retryable */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/** Sleep helper */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class LLMClient {
  constructor(config = {}) {
    this.endpoint = (config.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o-mini';
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature ?? 0.3;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getConfig() {
    return {
      endpoint: this.endpoint,
      model: this.model,
      hasApiKey: !!this.apiKey,
    };
  }

  /**
   * Streaming chat completion — yields content chunks, with automatic retry.
   * Retries are only attempted before any content has been yielded;
   * once streaming starts, a mid-stream error will be thrown (no way to resume).
   *
   * Options (in addition to existing):
   *   maxRetries  — override instance-level retry count for this call
   *   timeoutMs   — per-attempt timeout in milliseconds (0 = no timeout)
   *   signal      — user-provided AbortSignal for manual cancellation
   *   onRetry(n)  — called before each retry attempt (n = attempt number)
   */
  async *chatStream(messages, options = {}) {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const userSignal = options.signal ?? null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Notify caller before each retry (not on the first attempt)
      if (attempt > 0 && options.onRetry) {
        options.onRetry(attempt);
      }

      // Per-attempt abort controller that combines user signal + timeout
      const controller = new AbortController();
      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
            const err = new DOMException('Request timed out', 'AbortError');
            err._timeout = true;
            controller.abort(err);
          }, timeoutMs)
        : null;

      // Forward user-initiated abort to our controller
      const onUserAbort = () => controller.abort();
      userSignal?.addEventListener('abort', onUserAbort, { once: true });

      let retryable = false;
      let retryReason = '';

      try {
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
          signal: controller.signal,
        });

        if (!response.ok) {
          if (isRetryableStatus(response.status)) {
            retryable = true;
            retryReason = `HTTP ${response.status}`;
            // Read error body to drain the response
            await response.text().catch(() => {});
            continue; // retry
          }
          const errorText = await response.text();
          throw new Error(`LLM API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error('Response body is null — streaming not supported');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastUsage = null;
        let yieldedAny = false;

        try {
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

                // Support "thinking" mode: DeepSeek-style reasoning_content
                const reasoningContent = json.choices?.[0]?.delta?.reasoning_content;
                if (reasoningContent && options.onThinking) {
                  options.onThinking(reasoningContent);
                }

                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  yieldedAny = true;
                  yield content;
                }
              } catch {
                // skip malformed SSE chunks
              }
            }
          }
        } catch (streamError) {
          // Mid-stream error: if we already yielded content, we can't retry
          // (no way to resume a partial SSE stream). Just throw.
          if (yieldedAny) {
            throw streamError;
          }
          // No content yielded yet — safe to retry
          if (isRetryableError(streamError)) {
            retryable = true;
            retryReason = streamError.message;
            continue;
          }
          throw streamError;
        }

        // Stream completed successfully
        if (lastUsage && options.onUsage) {
          options.onUsage(lastUsage);
        }
        return; // done
      } catch (error) {
        if (isRetryableError(error)) {
          retryable = true;
          retryReason = error.message;
          continue; // retry
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        userSignal?.removeEventListener('abort', onUserAbort);
      }
    } // end retry loop

    // All retries exhausted — throw the last reason
    throw new Error(
      `LLM request failed after ${maxRetries + 1} attempts (last reason: ${retryReason || 'unknown'})`
    );
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
