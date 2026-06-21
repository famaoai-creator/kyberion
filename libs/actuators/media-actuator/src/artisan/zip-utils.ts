import AdmZip from 'adm-zip';

type ZipEntry = ReturnType<AdmZip['getEntries']>[number];

export function readZipEntryText(zip: AdmZip, entryName: string): string | undefined {
  const entry = zip.getEntry(entryName);
  return entry ? entry.getData().toString('utf8') : undefined;
}

export function findZipEntries(zip: AdmZip, pattern: RegExp): ZipEntry[] {
  return zip.getEntries().filter(entry => pattern.test(entry.entryName));
}

export function collectXmlText(xml: string, pattern: RegExp): string[] {
  return [...xml.matchAll(pattern)]
    .map(match => match[1] ?? '')
    .filter(value => value.length > 0);
}
