export function chunkText(text, size = 12000) {
  const source = String(text ?? '');
  if (!source) return [];

  const chunks = [];
  let remaining = source;

  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf('\n\n', size);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf('\n', size);
    }
    if (splitAt <= 0) {
      splitAt = size;
    }
    const head = remaining.slice(0, splitAt).trimEnd();
    if (head) {
      chunks.push(head);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
