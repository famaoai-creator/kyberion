// @ts-ignore
import jschardet from 'jschardet';

export interface EncodingResult {
  encoding: string;
  confidence: number;
  lineEnding: 'CRLF' | 'LF' | 'CR' | 'unknown';
}

export function detectEncoding(buffer: Buffer): EncodingResult {
  const result = jschardet.detect(buffer);
  const content = buffer.toString();
  let lineEnding: EncodingResult['lineEnding'] = 'unknown';

  if (content.includes('\r\n')) lineEnding = 'CRLF';
  else if (content.includes('\n')) lineEnding = 'LF';
  else if (content.includes('\r')) lineEnding = 'CR';

  return { ...result, lineEnding };
}
