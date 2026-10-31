import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package-manifest.json'), 'utf8'));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || !Object.keys(manifest).length) {
    throw Error('package-manifest.json: пустой или неверный манифест');
  }
  const failures = [];
  for (const [name, expected] of Object.entries(manifest)) {
    if (!name || name.includes('..') || name.includes('\\') || path.isAbsolute(name) || !/^[a-f0-9]{64}$/.test(expected)) {
      throw Error('package-manifest.json: неверная запись ' + JSON.stringify(name));
    }
    let data;
    try { data = await fs.readFile(path.join(root, name)); }
    catch (error) {
      failures.push(`${name}: ${error.code === 'ENOENT' ? 'файл отсутствует' : 'ошибка чтения (' + error.code + ')'}`);
      continue;
    }
    // Termux replaces only the interpreter line; script contents remain protected.
    if (name.endsWith('.sh')) data = Buffer.from(data.toString().replace(/^#![^\n]+/, '#!/usr/bin/env bash'));
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) failures.push(`${name}: SHA-256 не совпадает\n  ожидается: ${expected}\n  получено:  ${actual}`);
  }
  if (failures.length) throw Error(failures.join('\n'));
  console.log(`Проверка целостности файлов: OK (${Object.keys(manifest).length})`);
} catch (error) {
  console.error('Файлы приложения отсутствуют или повреждены. Распакуйте полный исходный ZIP заново.');
  console.error(error.message);
  process.exitCode = 1;
}
