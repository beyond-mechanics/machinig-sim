// The page for the desktop app: dist/index.html (a page body, as published) inside a full HTML
// document, written to native/app/web/index.html. Run after `npm run build`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const body = readFileSync('dist/index.html', 'utf8');
const html = '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
mkdirSync('native/app/web', { recursive: true });
writeFileSync('native/app/web/index.html', html);
console.log('native/app/web/index.html', (html.length / 1024).toFixed(0), 'KB');
