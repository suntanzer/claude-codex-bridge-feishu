import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.conf', '.cpp', '.cs', '.css', '.csv', '.env',
  '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json', '.jsx',
  '.log', '.lua', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql',
  '.text', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const TEXT_MIME_HINTS = [
  'application/json', 'application/ld+json', 'application/sql',
  'application/toml', 'application/typescript', 'application/xml',
  'application/x-httpd-php', 'application/x-javascript', 'application/x-sh',
  'application/x-yaml', 'application/yaml', 'image/svg+xml',
];

function sanitizeFilename(raw, fallback) {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return normalized || fallback;
}

async function allocateFilePath(dirPath, preferredName) {
  const dotIndex = preferredName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < (preferredName.length - 1);
  const nameStem = hasExtension ? preferredName.slice(0, dotIndex) : preferredName;
  const extension = hasExtension ? preferredName.slice(dotIndex) : '';

  let candidate = join(dirPath, preferredName);
  for (let index = 1; index <= 1000; index += 1) {
    try {
      await writeFile(candidate, '', { flag: 'wx' });
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      candidate = join(dirPath, `${nameStem}-${index}${extension}`);
    }
  }
  throw new Error(`Unable to allocate inbound file path for ${preferredName}`);
}

function looksLikeTextByMime(contentType = '') {
  if (!contentType) return false;
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('text/') || TEXT_MIME_HINTS.includes(normalized);
}

function looksLikeTextByExtension(fileName = '') {
  return TEXT_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function looksLikeTextBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let suspicious = 0;
  let highBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
    if (byte > 127) {
      highBytes += 1;
    }
  }
  if ((suspicious / sample.length) >= 0.1) {
    return false;
  }
  if (highBytes === 0) {
    return true;
  }
  const decoded = sample.toString('utf8');
  const replacementCount = Array.from(decoded).filter((char) => char === '\uFFFD').length;
  return replacementCount === 0;
}

function buildInlineText(buffer, maxBytes) {
  if (!buffer || buffer.length === 0) return '';
  const slice = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  const text = slice.toString('utf8').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  if (buffer.length <= maxBytes) {
    return text;
  }
  return `${text}\n\n[truncated after ${maxBytes} bytes]`;
}

function isInlineTextCandidate({ fileName, contentType, buffer }) {
  return (
    looksLikeTextByMime(contentType) ||
    looksLikeTextByExtension(fileName) ||
    looksLikeTextBuffer(buffer)
  );
}

const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

function guessImageFilename(fileKey, contentType) {
  const ext = IMAGE_EXTENSIONS[contentType] || '.png';
  const shortKey = String(fileKey || 'image').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
  return `${shortKey}${ext}`;
}

function buildAttachmentPrompt({ message, attachments, skippedCount, failures }) {
  const sections = [];
  sections.push(
    message ||
      'The user sent one or more files in Feishu with no accompanying text. Inspect the files and respond based on their contents.',
  );
  sections.push('');
  sections.push('[Feishu attachments]');
  sections.push(`Downloaded files: ${attachments.length}`);
  if (skippedCount > 0) {
    sections.push(`Not downloaded due to per-message file limit: ${skippedCount}`);
  }
  if (failures.length > 0) {
    sections.push(`Download failures: ${failures.length}`);
  }
  sections.push('The downloaded files are available locally at the absolute paths below.');

  for (const [index, attachment] of attachments.entries()) {
    sections.push('');
    sections.push(`${index + 1}. ${attachment.fileName}`);
    sections.push(`- file_key: ${attachment.fileKey}`);
    sections.push(`- path: ${attachment.savedPath}`);
    sections.push(`- content_type: ${attachment.contentType || 'unknown'}`);
    sections.push(`- size_bytes: ${attachment.size}`);
    if (attachment.inlineText) {
      sections.push('- inline_text:');
      sections.push('```text');
      sections.push(attachment.inlineText);
      sections.push('```');
    }
  }

  if (failures.length > 0) {
    sections.push('');
    sections.push('Failed attachment downloads:');
    for (const failure of failures) {
      sections.push(`- ${failure.fileKey}: ${failure.error}`);
    }
  }

  return sections.join('\n');
}

export function createInboundPromptBuilder({ config, feishu, logger }) {
  const inboundRootDir = join(config.dataDir, 'inbound');

  return async function buildPromptForMessage({ messageId, mediaRefs, message = '' }) {
    const trimmedMessage = String(message || '').trim();

    if (!Array.isArray(mediaRefs) || mediaRefs.length === 0) {
      return trimmedMessage;
    }

    const keptRefs = mediaRefs.slice(0, config.inboundFileMaxCount);
    const skippedCount = Math.max(0, mediaRefs.length - keptRefs.length);
    const failures = [];
    const attachments = [];
    const msgDir = join(inboundRootDir, String(messageId || 'unknown-msg'));
    await mkdir(msgDir, { recursive: true });

    for (const ref of keptRefs) {
      try {
        const download = await feishu.downloadResource({
          messageId,
          fileKey: ref.fileKey,
          type: ref.type,
          maxBytes: config.inboundFileMaxBytes,
        });
        const preferredName = download.fileName || ref.fileName || guessImageFilename(ref.fileKey, download.contentType);
        const safeName = sanitizeFilename(preferredName, `${ref.fileKey}.bin`);
        const reservedPath = await allocateFilePath(msgDir, safeName);
        await writeFile(reservedPath, download.buffer);
        const inlineText = isInlineTextCandidate({
          fileName: safeName,
          contentType: download.contentType,
          buffer: download.buffer,
        })
          ? buildInlineText(download.buffer, config.inboundInlineTextBytes)
          : '';

        attachments.push({
          fileKey: ref.fileKey,
          fileName: safeName,
          savedPath: reservedPath,
          contentType: download.contentType,
          size: download.size,
          inlineText,
        });
      } catch (error) {
        const failure = {
          fileKey: ref.fileKey,
          error: String(error?.message || error),
        };
        failures.push(failure);
        logger.error(`failed to stage Feishu file ${ref.fileKey}: ${failure.error}`);
      }
    }

    if (attachments.length === 0 && !trimmedMessage) {
      const details = failures.length > 0
        ? ` Download errors: ${failures.map((item) => `${item.fileKey}: ${item.error}`).join('; ')}`
        : '';
      return `The user sent Feishu files, but none could be downloaded.${details}`.trim();
    }

    return buildAttachmentPrompt({
      message: trimmedMessage,
      attachments,
      skippedCount,
      failures,
    });
  };
}
