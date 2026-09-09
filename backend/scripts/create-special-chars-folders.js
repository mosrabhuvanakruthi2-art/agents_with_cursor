/**
 * Creates a "Special Characters" folder in Agent My Drive with 5 subfolders:
 *   1. ASCII special characters
 *   2. Unicode symbols
 *   3. Emojis
 *   4. Accented / international characters
 *   5. Mixed (all types combined)
 * Run: node scripts/create-special-chars-folders.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const driveClient = require('../src/clients/driveClient');

const EMAIL = 'zara@storefuze.com';
const ROOT  = '1js5PWQKmjpRWwDG1CUYNeac4pE_RSFqO';  // Agent My Drive

const SUBFOLDERS = [
  {
    label: 'ASCII Special Characters',
    name:  'ASCII Special Characters !@#$%^&*()-_+=[]{}|;<>~`',
  },
  {
    label: 'Unicode Symbols',
    name:  'Unicode Symbols © ® ™ ° ± µ Ω π √ ∞ ≈ ≠ ≤ ≥ ∑ ∏ ∫ Δ λ ψ ←→↑↓ ✓ ✗ ★ ♠ ♣ ♥ ♦',
  },
  {
    label: 'Emojis',
    name:  'Emojis 🚀🎯📁💡🔥⭐🌟💎🎉🏆🐱🐶🦊🌈🍕🎸🧠💻📊🗲✅❌🔑',
  },
  {
    label: 'Accented & International Characters',
    name:  'Accented International Characters café résumé naïve über Ñoño Zürich Ångström Søren João François 中文 日本語 한국어',
  },
  {
    label: 'Mixed — All Types Combined',
    name:  'Mixed All Types 🔥Special_Chars!@#©™★∞±Ñ–—«»„“❝❞ αλφα βήτα 🎉éàüñ',
  },
];

async function run() {
  console.log('\nCreating "Special Characters" folder in Agent My Drive...\n');

  // Find or create the parent
  let parent = await driveClient.findByName('Special Characters', ROOT, EMAIL);
  if (parent) {
    console.log(`  Found existing "Special Characters" folder: ${parent.id}`);
  } else {
    parent = await driveClient.createFolder('Special Characters', ROOT, EMAIL);
    console.log(`  Created "Special Characters" folder: ${parent.id}`);
  }

  console.log('\n  Creating subfolders:\n');
  for (const sf of SUBFOLDERS) {
    const folder = await driveClient.createFolder(sf.name, parent.id, EMAIL);
    console.log(`  ✓  [${sf.label}]`);
    console.log(`       Name : ${sf.name}`);
    console.log(`       Len  : ${sf.name.length} chars`);
    console.log(`       ID   : ${folder.id}\n`);
  }

  console.log('─'.repeat(60));
  console.log(`  Done — 5 subfolders created under "Special Characters".`);
}

run().catch(console.error);