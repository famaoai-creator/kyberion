import { NativePdfParser } from '../libs/core/src/native-pdf-engine/parser.js';
import { logger, pathResolver } from '../libs/core/index.js';

async function main() {
  const source = pathResolver.rootResolve('vault/PDF20_AN001-BPC.pdf');
  const parser = new NativePdfParser(source);
  
  const metadata = parser.extractMetadata();
  const pages = parser.extractPages();

  console.log('--- PDF Extraction Debug ---');
  console.log('Metadata:', JSON.stringify(metadata, null, 2));
  console.log('Page Count:', pages.length);
  
  pages.forEach((p, i) => {
    console.log(`Page ${p.pageNumber}: ${p.text.substring(0, 100)}...`);
  });
}

main().catch(err => console.error(err));
