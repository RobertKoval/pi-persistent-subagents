export const DEFAULT_MAX_JSONL_BUFFER_BYTES = 8 * 1024 * 1024;

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function attachStrictJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  options: { maxBufferBytes?: number; onError?: (error: Error) => void } = {},
): () => void {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_JSONL_BUFFER_BYTES;
  let buffer = '';

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer, 'utf8') > maxBufferBytes) {
      const error = new Error(`RPC JSONL buffer exceeded ${maxBufferBytes} bytes without a complete LF-delimited record`);
      buffer = '';
      options.onError?.(error);
      return;
    }

    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  };

  stream.on('data', onData);
  return () => stream.removeListener('data', onData);
}
