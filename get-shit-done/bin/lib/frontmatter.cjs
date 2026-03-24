/**
 * Frontmatter — YAML frontmatter parsing, serialization, and CRUD commands
 */

const fs = require('fs');
const path = require('path');
const { safeReadFile, normalizeMd, output, error } = require('./core.cjs');

// ─── Parsing engine ───────────────────────────────────────────────────────────

function extractFrontmatter(content) {
  const frontmatter = {};
  // Find ALL frontmatter blocks at the start of the file.
  // If multiple blocks exist (corruption from CRLF mismatch), use the LAST one
  // since it represents the most recent state sync.
  const allBlocks = [...content.matchAll(/(?:^|\n)\s*---\r?\n([\s\S]+?)\r?\n---/g)];
  const match = allBlocks.length > 0 ? allBlocks[allBlocks.length - 1] : null;
  if (!match) return frontmatter;

  const yaml = match[1];
  const lines = yaml.split(/\r?\n/);

  // Stack to track nested objects: [{obj, key, indent}]
  // obj = object to write to, key = current key collecting array items, indent = indentation level
  let stack = [{ obj: frontmatter, key: null, indent: -1 }];

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // Calculate indentation (number of leading spaces)
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Pop stack back to appropriate level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    // Check for key: value pattern
    const keyMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)/);
    if (keyMatch) {
      const key = keyMatch[2];
      const value = keyMatch[3].trim();

      if (value === '' || value === '[') {
        // Key with no value or opening bracket — could be nested object or array
        // We'll determine based on next lines, for now create placeholder
        current.obj[key] = value === '[' ? [] : {};
        current.key = null;
        // Push new context for potential nested content
        stack.push({ obj: current.obj[key], key: null, indent });
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: key: [a, b, c]
        current.obj[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        current.key = null;
      } else {
        // Simple key: value
        current.obj[key] = value.replace(/^["']|["']$/g, '');
        current.key = null;
      }
    } else if (line.trim().startsWith('- ')) {
      // Array item
      const itemValue = line.trim().slice(2).replace(/^["']|["']$/g, '');

      // If current context is an empty object, convert to array
      if (typeof current.obj === 'object' && !Array.isArray(current.obj) && Object.keys(current.obj).length === 0) {
        // Find the key in parent that points to this object and convert it
        const parent = stack.length > 1 ? stack[stack.length - 2] : null;
        if (parent) {
          for (const k of Object.keys(parent.obj)) {
            if (parent.obj[k] === current.obj) {
              parent.obj[k] = [itemValue];
              current.obj = parent.obj[k];
              break;
            }
          }
        }
      } else if (Array.isArray(current.obj)) {
        current.obj.push(itemValue);
      }
    }
  }

  return frontmatter;
}

function reconstructFrontmatter(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every(v => typeof v === 'string') && value.length <= 3 && value.join(', ').length < 60) {
        lines.push(`${key}: [${value.join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subkey, subval] of Object.entries(value)) {
        if (subval === null || subval === undefined) continue;
        if (Array.isArray(subval)) {
          if (subval.length === 0) {
            lines.push(`  ${subkey}: []`);
          } else if (subval.every(v => typeof v === 'string') && subval.length <= 3 && subval.join(', ').length < 60) {
            lines.push(`  ${subkey}: [${subval.join(', ')}]`);
          } else {
            lines.push(`  ${subkey}:`);
            for (const item of subval) {
              lines.push(`    - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
            }
          }
        } else if (typeof subval === 'object') {
          lines.push(`  ${subkey}:`);
          for (const [subsubkey, subsubval] of Object.entries(subval)) {
            if (subsubval === null || subsubval === undefined) continue;
            if (Array.isArray(subsubval)) {
              if (subsubval.length === 0) {
                lines.push(`    ${subsubkey}: []`);
              } else {
                lines.push(`    ${subsubkey}:`);
                for (const item of subsubval) {
                  lines.push(`      - ${item}`);
                }
              }
            } else {
              lines.push(`    ${subsubkey}: ${subsubval}`);
            }
          }
        } else {
          const sv = String(subval);
          lines.push(`  ${subkey}: ${sv.includes(':') || sv.includes('#') ? `"${sv}"` : sv}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{')) {
        lines.push(`${key}: "${sv}"`);
      } else {
        lines.push(`${key}: ${sv}`);
      }
    }
  }
  return lines.join('\n');
}

function spliceFrontmatter(content, newObj) {
  const yamlStr = reconstructFrontmatter(newObj);
  const match = content.match(/^---\r?\n[\s\S]+?\r?\n---/);
  if (match) {
    return `---\n${yamlStr}\n---` + content.slice(match[0].length);
  }
  return `---\n${yamlStr}\n---\n\n` + content;
}

function stripYamlQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseMustHavesScalar(value) {
  const normalized = stripYamlQuotes(value.trim());
  return /^\d+$/.test(normalized) ? parseInt(normalized, 10) : normalized;
}

function parseMustHavesBlock(content, blockName) {
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split(/\r?\n/);
  const mustHavesIndex = lines.findIndex(line => /^\s*must_haves:\s*$/.test(line));
  if (mustHavesIndex === -1) return [];

  const mustHavesIndent = lines[mustHavesIndex].match(/^(\s*)/)[1].length;
  let blockIndent = -1;
  let blockStartIndex = -1;

  for (let index = mustHavesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;

    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= mustHavesIndent) break;

    const keyMatch = line.match(/^\s*([a-zA-Z0-9_-]+):\s*$/);
    if (keyMatch && keyMatch[1] === blockName) {
      blockIndent = indent;
      blockStartIndex = index + 1;
      break;
    }
  }

  if (blockStartIndex === -1) return [];

  // List items are indented one level deeper than blockIndent
  // Continuation KVs are indented one level deeper than list items
  const items = [];
  let current = null;
  let itemIndent = -1;
  let currentArrayKey = null;
  let currentArrayIndent = -1;

  const pushCurrent = () => {
    if (current !== null) items.push(current);
  };

  for (let index = blockStartIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= blockIndent) break;

    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (itemIndent === -1 || indent === itemIndent) {
        pushCurrent();
        itemIndent = indent;
        currentArrayKey = null;
        currentArrayIndent = -1;

        const itemValue = trimmed.slice(2).trim();
        if (itemValue === '') {
          current = {};
          continue;
        }

        if (!/^["']/.test(itemValue)) {
          const kvMatch = itemValue.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
          if (kvMatch) {
            current = {};
            if (kvMatch[2].trim() === '') {
              current[kvMatch[1]] = [];
              currentArrayKey = kvMatch[1];
              currentArrayIndent = indent;
            } else {
              current[kvMatch[1]] = parseMustHavesScalar(kvMatch[2]);
            }
            continue;
          }
        }

        current = parseMustHavesScalar(itemValue);
        continue;
      }

      if (current && typeof current === 'object' && currentArrayKey && indent > currentArrayIndent) {
        if (!Array.isArray(current[currentArrayKey])) {
          current[currentArrayKey] = current[currentArrayKey] ? [current[currentArrayKey]] : [];
        }
        current[currentArrayKey].push(parseMustHavesScalar(trimmed.slice(2)));
      }
      continue;
    }

    if (current && typeof current === 'object') {
      const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (kvMatch) {
        if (kvMatch[2].trim() === '') {
          current[kvMatch[1]] = [];
          currentArrayKey = kvMatch[1];
          currentArrayIndent = indent;
        } else {
          current[kvMatch[1]] = parseMustHavesScalar(kvMatch[2]);
          currentArrayKey = null;
          currentArrayIndent = -1;
        }
      }
    }
  }

  pushCurrent();

  return items;
}

// ─── Frontmatter CRUD commands ────────────────────────────────────────────────

const FRONTMATTER_SCHEMAS = {
  plan: { required: ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'] },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

function cmdFrontmatterGet(cwd, filePath, field, raw) {
  if (!filePath) { error('file path required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }
  const fm = extractFrontmatter(content);
  if (field) {
    const value = fm[field];
    if (value === undefined) { output({ error: 'Field not found', field }, raw); return; }
    output({ [field]: value }, raw, JSON.stringify(value));
  } else {
    output(fm, raw);
  }
}

function cmdFrontmatterSet(cwd, filePath, field, value, raw) {
  if (!filePath || !field || value === undefined) { error('file, field, and value required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let parsedValue;
  try { parsedValue = JSON.parse(value); } catch { parsedValue = value; }
  fm[field] = parsedValue;
  const newContent = spliceFrontmatter(content, fm);
  fs.writeFileSync(fullPath, normalizeMd(newContent), 'utf-8');
  output({ updated: true, field, value: parsedValue }, raw, 'true');
}

function cmdFrontmatterMerge(cwd, filePath, data, raw) {
  if (!filePath || !data) { error('file and data required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let mergeData;
  try { mergeData = JSON.parse(data); } catch { error('Invalid JSON for --data'); return; }
  Object.assign(fm, mergeData);
  const newContent = spliceFrontmatter(content, fm);
  fs.writeFileSync(fullPath, normalizeMd(newContent), 'utf-8');
  output({ merged: true, fields: Object.keys(mergeData) }, raw, 'true');
}

function cmdFrontmatterValidate(cwd, filePath, schemaName, raw) {
  if (!filePath || !schemaName) { error('file and schema required'); }
  const schema = FRONTMATTER_SCHEMAS[schemaName];
  if (!schema) { error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }
  const fm = extractFrontmatter(content);
  const missing = schema.required.filter(f => fm[f] === undefined);
  const present = schema.required.filter(f => fm[f] !== undefined);
  output({ valid: missing.length === 0, missing, present, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

module.exports = {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
  FRONTMATTER_SCHEMAS,
  cmdFrontmatterGet,
  cmdFrontmatterSet,
  cmdFrontmatterMerge,
  cmdFrontmatterValidate,
};
