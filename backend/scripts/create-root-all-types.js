/**
 * Creates one file of every major type at the root of Agent My Drive.
 * Run from backend/: node scripts/create-root-all-types.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const driveClient = require('../src/clients/driveClient');

const EMAIL          = 'zara@storefuze.com';
const ROOT_FOLDER_ID = '1js5PWQKmjpRWwDG1CUYNeac4pE_RSFqO';

// ── Minimal valid binary content ──────────────────────────────────────────────

// 1×1 transparent PNG
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

// 1×1 white JPEG
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJgAB/9k=',
  'base64'
);

// 1×1 GIF
const GIF_1x1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// 1×1 white BMP (58 bytes)
const BMP_1x1 = Buffer.from(
  '424D3A0000000000000036000000280000000100000001000000010018000000000000000000130B0000130B00000000000000000000FFFFFF00',
  'hex'
);

// Minimal valid empty WAV (44 bytes, PCM mono 44100 Hz 16-bit, 0 samples)
const WAV_EMPTY = Buffer.from(
  '524946462400000057415645666D7420100000000100010044AC00008858010002001000646174610000 0000'.replace(/\s/g, ''),
  'hex'
);

// Minimal empty ZIP (22-byte EOCD record)
const ZIP_EMPTY = Buffer.from('504B0506000000000000000000000000000000000000', 'hex');

// Minimal valid PDF (renders one blank page)
const PDF_MINIMAL = Buffer.from(
  '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\n' +
  'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
  '0000000058 00000 n \n0000000115 00000 n \n' +
  'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF'
);

// SVG (text-based vector image)
const SVG_CONTENT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<rect width="200" height="100" fill="#4285f4"/>' +
  '<text x="100" y="55" text-anchor="middle" fill="white" font-family="Arial" font-size="16">Drive QA</text>' +
  '</svg>'
);

// Placeholder for binary formats where exact validity is not required
function placeholder(ext) {
  return Buffer.from(
    `[QA TEST FILE - ${ext.toUpperCase()} FORMAT]\n` +
    `This is a placeholder file for Drive-to-OneDrive migration QA.\n` +
    `File type: .${ext}\n` +
    `Purpose: Verify CloudFuze migrates this MIME type correctly.\n`
  );
}

// ── File manifest ─────────────────────────────────────────────────────────────

const UPLOADED_FILES = [
  // Text & Documents
  { name: 'root_text.txt',           mime: 'text/plain',            content: Buffer.from('Root level plain text file.\nLine 2: Drive QA test data.\nLine 3: CloudFuze migration.') },
  { name: 'root_markdown.md',        mime: 'text/markdown',         content: Buffer.from('# Drive QA Root File\n\n## Purpose\nMigration test — plain markdown.\n\n- Feature: root-level files\n- Target: OneDrive\n\n**Status:** Ready') },
  { name: 'root_rich_text.rtf',      mime: 'application/rtf',       content: Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Root RTF document for Drive-to-OneDrive migration QA.\\par}') },
  { name: 'root_log.log',            mime: 'text/plain',            content: Buffer.from('[2026-06-10 10:00:00] INFO  Server started\n[2026-06-10 10:00:01] INFO  DB connected\n[2026-06-10 10:00:02] WARN  High memory usage\n[2026-06-10 10:00:03] ERROR Timeout') },
  { name: 'root_config.ini',         mime: 'text/plain',            content: Buffer.from('[General]\nAppName=DriveQA\nVersion=2.0\n\n[Database]\nHost=localhost\nPort=5432\nName=qa_db\n\n[Migration]\nMode=full') },

  // Web & Code
  { name: 'root_webpage.html',       mime: 'text/html',             content: Buffer.from('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Drive QA</title></head><body><h1>Root HTML File</h1><p>Drive-to-OneDrive migration test.</p></body></html>') },
  { name: 'root_stylesheet.css',     mime: 'text/css',              content: Buffer.from('/* Root CSS file — Drive QA */\nbody { font-family: Arial, sans-serif; margin: 0; padding: 20px; }\nh1   { color: #4285f4; font-size: 2rem; }\n.qa  { border: 1px solid #ccc; padding: 1rem; }') },
  { name: 'root_script.js',          mime: 'application/javascript',content: Buffer.from('// Root JavaScript — Drive QA\nconst version = "v1.0";\nfunction migrateFile(file) {\n  console.log(`Migrating ${file} [${version}]`);\n  return { status: "ok", file };\n}\nconsole.log(migrateFile("root_script.js"));') },
  { name: 'root_script.ts',          mime: 'application/typescript',content: Buffer.from('// Root TypeScript — Drive QA\ninterface MigrationFile { name: string; size: number; }\nfunction migrate(f: MigrationFile): string {\n  return `Migrated ${f.name} (${f.size} bytes)`;\n}\nconsole.log(migrate({ name: "root_script.ts", size: 512 }));') },
  { name: 'root_script.py',          mime: 'text/x-python',         content: Buffer.from('# Root Python — Drive QA\nfrom typing import Dict\n\ndef migrate(file: Dict[str, str]) -> str:\n    return f"Migrated {file[\'name\']}"\n\nprint(migrate({"name": "root_script.py", "type": "python"}))\n') },
  { name: 'root_script.java',        mime: 'text/x-java-source',   content: Buffer.from('// Root Java — Drive QA\npublic class DriveQA {\n    public static void main(String[] args) {\n        System.out.println("Root Java file for Drive migration QA");\n    }\n}') },
  { name: 'root_script.cpp',         mime: 'text/x-c++src',        content: Buffer.from('#include <iostream>\n#include <string>\n// Root C++ — Drive QA\nint main() {\n    std::string msg = "Root C++ file - Drive QA";\n    std::cout << msg << std::endl;\n    return 0;\n}') },
  { name: 'root_script.sh',          mime: 'application/x-sh',     content: Buffer.from('#!/bin/bash\n# Root shell script — Drive QA\necho "Drive-to-OneDrive migration QA script"\nls -la ./\nexit 0') },
  { name: 'root_query.sql',          mime: 'application/sql',       content: Buffer.from('-- Root SQL — Drive QA\nSELECT f.id, f.name, f.mime_type, f.size\nFROM drive_files f\nWHERE f.parent = \'Agent My Drive\'\n  AND f.trashed = false\nORDER BY f.name ASC;') },

  // Data formats
  { name: 'root_data.json',          mime: 'application/json',      content: Buffer.from(JSON.stringify({ app: 'DriveQA', version: '1.0.0', features: ['migration', 'versioning', 'permissions'], fileTypes: 40, rootLevel: true }, null, 2)) },
  { name: 'root_config.yaml',        mime: 'application/x-yaml',   content: Buffer.from('app: DriveQA\nversion: 1.0.0\nfeatures:\n  - migration\n  - versioning\n  - permissions\nmigration:\n  source: Google My Drive\n  destination: OneDrive\n  mode: full') },
  { name: 'root_config.yml',         mime: 'application/x-yaml',   content: Buffer.from('# Alternate .yml extension\napp: DriveQA\nversion: 1.0.0\nenabled: true\ntags:\n  - drive\n  - onedrive\n  - qa') },
  { name: 'root_data.xml',           mime: 'application/xml',       content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<driveqa version="1.0">\n  <source>Google My Drive</source>\n  <destination>OneDrive</destination>\n  <file type="root">\n    <name>root_data.xml</name>\n    <purpose>Migration QA</purpose>\n  </file>\n</driveqa>') },
  { name: 'root_data.csv',           mime: 'text/csv',              content: Buffer.from('id,name,type,size_bytes,created\n1,root_text.txt,text,128,2026-06-10\n2,root_photo.jpg,image,2048,2026-06-10\n3,root_video.mp4,video,10240,2026-06-10\n4,root_document.pdf,document,4096,2026-06-10') },
  { name: 'root_data.tsv',           mime: 'text/tab-separated-values', content: Buffer.from('id\tname\ttype\tsize\n1\troot_text\tplain text\t128\n2\troot_sheet\tspreadsheet\t2048') },

  // Office documents (modern OOXML)
  { name: 'root_document.pdf',       mime: 'application/pdf',       content: PDF_MINIMAL },
  { name: 'root_word.docx',          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',    content: placeholder('docx') },
  { name: 'root_excel.xlsx',         mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          content: placeholder('xlsx') },
  { name: 'root_powerpoint.pptx',    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',  content: placeholder('pptx') },

  // Office documents (legacy binary formats)
  { name: 'root_word_legacy.doc',    mime: 'application/msword',              content: placeholder('doc') },
  { name: 'root_excel_legacy.xls',   mime: 'application/vnd.ms-excel',        content: placeholder('xls') },
  { name: 'root_ppt_legacy.ppt',     mime: 'application/vnd.ms-powerpoint',   content: placeholder('ppt') },

  // Images
  { name: 'root_photo.jpg',          mime: 'image/jpeg',            content: JPEG_1x1 },
  { name: 'root_image.png',          mime: 'image/png',             content: PNG_1x1 },
  { name: 'root_animation.gif',      mime: 'image/gif',             content: GIF_1x1 },
  { name: 'root_bitmap.bmp',         mime: 'image/bmp',             content: BMP_1x1 },
  { name: 'root_vector.svg',         mime: 'image/svg+xml',         content: SVG_CONTENT },
  { name: 'root_photo.tiff',         mime: 'image/tiff',            content: placeholder('tiff') },
  { name: 'root_photo.webp',         mime: 'image/webp',            content: placeholder('webp') },

  // Audio
  { name: 'root_audio.mp3',          mime: 'audio/mpeg',            content: placeholder('mp3') },
  { name: 'root_audio.wav',          mime: 'audio/wav',             content: WAV_EMPTY },
  { name: 'root_audio.aac',          mime: 'audio/aac',             content: placeholder('aac') },
  { name: 'root_audio.ogg',          mime: 'audio/ogg',             content: placeholder('ogg') },
  { name: 'root_audio.flac',         mime: 'audio/flac',            content: placeholder('flac') },

  // Video
  { name: 'root_video.mp4',          mime: 'video/mp4',             content: placeholder('mp4') },
  { name: 'root_video.avi',          mime: 'video/x-msvideo',       content: placeholder('avi') },
  { name: 'root_video.mov',          mime: 'video/quicktime',       content: placeholder('mov') },
  { name: 'root_video.mkv',          mime: 'video/x-matroska',      content: placeholder('mkv') },
  { name: 'root_video.wmv',          mime: 'video/x-ms-wmv',        content: placeholder('wmv') },

  // Archives & Compressed
  { name: 'root_archive.zip',        mime: 'application/zip',       content: ZIP_EMPTY },
  { name: 'root_archive.tar',        mime: 'application/x-tar',     content: placeholder('tar') },
  { name: 'root_archive.gz',         mime: 'application/gzip',      content: placeholder('gz') },
  { name: 'root_archive.rar',        mime: 'application/vnd.rar',   content: placeholder('rar') },
  { name: 'root_archive.7z',         mime: 'application/x-7z-compressed', content: placeholder('7z') },
];

// Google Workspace native files (created separately via Drive API)
const NATIVE_FILES = [
  { name: 'root_google_doc',   mime: 'application/vnd.google-apps.document' },
  { name: 'root_google_sheet', mime: 'application/vnd.google-apps.spreadsheet' },
  { name: 'root_google_slide', mime: 'application/vnd.google-apps.presentation' },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  const total = UPLOADED_FILES.length + NATIVE_FILES.length;
  console.log(`\nCreating ${total} files in Agent My Drive root (${EMAIL})...\n`);

  let created = 0, failed = 0;

  for (const f of UPLOADED_FILES) {
    try {
      const result = await driveClient.uploadFile(f.name, f.mime, f.content, ROOT_FOLDER_ID, EMAIL);
      console.log(`  ✓  ${f.name.padEnd(36)} ${result.id}`);
      created++;
    } catch (err) {
      console.error(`  ✗  ${f.name.padEnd(36)} ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log('\n  [Google Workspace native files]');
  for (const f of NATIVE_FILES) {
    try {
      const result = await driveClient.createNativeFile(f.name, f.mime, ROOT_FOLDER_ID, EMAIL);
      console.log(`  ✓  ${f.name.padEnd(36)} ${result.id}`);
      created++;
    } catch (err) {
      console.error(`  ✗  ${f.name.padEnd(36)} ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Created : ${created}`);
  console.log(`  Failed  : ${failed}`);
  console.log(`  Total   : ${total}`);
}

run().catch(console.error);