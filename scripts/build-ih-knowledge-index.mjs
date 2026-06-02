import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const knowledgeRoot = path.join(repoRoot, "IHassistant/knowledge");
const outFile = path.join(repoRoot, "flipgame/netlify/functions/_shared/ih-knowledge-index.mjs");
const allowedExtensions = new Set([".md", ".txt", ".json"]);

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

function cleanText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFor(relPath, text) {
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return relPath.replace(/README\.md$/i, "").replace(/\.md$/i, "").replace(/\/$/, "") || relPath;
}

const files = walk(knowledgeRoot).sort();
const chunks = [];

for (const fullPath of files) {
  const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");
  const text = cleanText(fs.readFileSync(fullPath, "utf8"));
  if (!text) continue;

  const title = titleFor(relPath, text);
  const maxChunkLength = 4200;
  for (let start = 0; start < text.length; start += maxChunkLength) {
    const body = text.slice(start, start + maxChunkLength).trim();
    if (!body) continue;
    const part = Math.floor(start / maxChunkLength) + 1;
    chunks.push({
      path: relPath,
      title: start === 0 ? title : `${title} (${part})`,
      body
    });
  }
}

const content = [
  "// Generated from IHassistant/knowledge Markdown/text files. Do not edit by hand.",
  "// Regenerate with: node scripts/build-ih-knowledge-index.mjs",
  `export const IH_KNOWLEDGE_CHUNKS = ${JSON.stringify(chunks, null, 2)};`,
  ""
].join("\n");

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, content);

console.log(JSON.stringify({
  files: files.length,
  chunks: chunks.length,
  outFile: path.relative(repoRoot, outFile)
}, null, 2));
