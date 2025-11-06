#!/usr/bin/env tsx

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

interface IndexEntry {
  id: string;
  title: string;
  domain: string;
  source: string;
  chunk_id: string;
  mini_summary: string;
  tags: string[];
  timestamp: string;
  version: string;
  status: string;
  freshness_score: number;
  importance_score: number;
  provenance: {
    author?: string;
    source_hash: string;
  };
}

interface Chunk {
  text: string;
  title: string | null;
  level: number;
  startLine: number;
  endLine: number;
}

export interface ClarityGearOptions {
  maxEntries?: number;
  partitionBy?: 'domain' | 'importance' | 'none';
  outputDir?: string;
  rootDir?: string;
}

export type PartitionStrategy = 'domain' | 'importance' | 'none';

const DEFAULT_MAX_ENTRIES = 600;
const DEFAULT_PARTITION_STRATEGY: PartitionStrategy = 'domain';
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.mdx', '.json', '.yaml', '.yml']);
const SOURCE_CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.turbo', '.cache', 'tmp', 'temp', 'docs/index']);
const EXCLUDE_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.env', '.env.local']);
const INDEX_LIMITS = {
  MAX_TOTAL_ENTRIES: 600,
  MAX_CHUNKS_PER_FILE: { '.md': 10, '.mdx': 10, '.ts': 5, '.tsx': 5, '.js': 5, '.jsx': 5, '.json': 1, '.yaml': 1, '.yml': 1 },
  MIN_FRESHNESS: 0.2,
  PRIORITIZE_DOCS: true,
  MAX_MINI_SUMMARY_LENGTH: 200,
};

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (match) {
    const frontmatterText = match[1];
    const body = match[2];
    const frontmatter: Record<string, any> = {};
    frontmatterText.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
        frontmatter[key] = value;
      }
    });
    return { frontmatter, body };
  }
  return { frontmatter: {}, body: content };
}

function improveTitle(chunk: Chunk, filePath: string, relativePath: string, miniSummary?: string): string {
  const title = chunk.title;
  if (title && title !== 'Introduction' && title !== 'Untitled' && title !== 'Document') {
    return title;
  }
  const headerMatch = chunk.text.match(/^(#{1,6})\s+(.+)$/m);
  if (headerMatch) {
    const headerTitle = headerMatch[2].trim();
    if (headerTitle && headerTitle !== 'Introduction') {
      return headerTitle;
    }
  }
  if (miniSummary && miniSummary.length > 20) {
    const words = miniSummary.split(/\s+/).slice(0, 10);
    const phrase = words.join(' ');
    const cleanPhrase = phrase.replace(/^(Introduction|Overview|Summary|Abstract):?\s*/i, '').trim();
    if (cleanPhrase.length > 10 && cleanPhrase.length < 60) {
      return cleanPhrase;
    }
  }
  const fileName = basename(filePath, extname(filePath));
  if (fileName && fileName !== 'index' && fileName !== 'README') {
    return fileName;
  }
  const pathParts = relativePath.split(/[/\\]/);
  const lastPart = pathParts[pathParts.length - 1];
  return basename(lastPart, extname(lastPart)) || 'Document';
}

function chunkMarkdown(content: string, minTokens: number = 150, maxTokens: number = 800): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let currentChunk: string[] = [];
  let currentTitle: string | null = null;
  let currentLevel = 0;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();
      if (currentChunk.length > 0) {
        const chunkText = currentChunk.join('\n').trim();
        const tokens = countTokens(chunkText);
        if (tokens >= minTokens) {
          chunks.push({
            text: chunkText,
            title: currentTitle || 'Document',
            level: currentLevel,
            startLine,
            endLine: i - 1,
          });
        } else if (chunks.length > 0) {
          chunks[chunks.length - 1].text += '\n\n' + chunkText;
          chunks[chunks.length - 1].endLine = i - 1;
        }
      }
      currentChunk = [line];
      currentTitle = title;
      currentLevel = level;
      startLine = i;
    } else {
      currentChunk.push(line);
      const chunkText = currentChunk.join('\n').trim();
      const tokens = countTokens(chunkText);
      if (tokens > maxTokens) {
        const sentences = chunkText.split(/(?<=[.!?])\s+/);
        let splitChunk: string[] = [];
        for (const sentence of sentences) {
          const testChunk = [...splitChunk, sentence].join(' ');
          if (countTokens(testChunk) > maxTokens && splitChunk.length > 0) {
            chunks.push({
              text: splitChunk.join(' '),
              title: currentTitle || 'Document',
              level: currentLevel,
              startLine,
              endLine: i,
            });
            startLine = i;
            splitChunk = [sentence];
          } else {
            splitChunk.push(sentence);
          }
        }
        currentChunk = splitChunk;
      }
    }
  }
  if (currentChunk.length > 0) {
    const chunkText = currentChunk.join('\n').trim();
    const tokens = countTokens(chunkText);
    if (tokens >= minTokens || chunks.length === 0) {
      chunks.push({
        text: chunkText,
        title: currentTitle || 'Document',
        level: currentLevel,
        startLine,
        endLine: lines.length - 1,
      });
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1].text += '\n\n' + chunkText;
      chunks[chunks.length - 1].endLine = lines.length - 1;
    }
  }
  return chunks;
}

function generateMiniSummary(text: string, title: string): string {
  const cleanText = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^\*]+)\*\*/g, '$1')
    .replace(/\*([^\*]+)\*/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  const sentences = cleanText.split(/[.!?]+\s+/).filter(s => s.length > 20);
  if (sentences.length === 0) {
    return `${title}: ${cleanText.substring(0, 100)}...`;
  }
  const summary = sentences.slice(0, 2).join('. ');
  const words = summary.split(/\s+/);
  if (words.length > 50) {
    return words.slice(0, 50).join(' ') + '...';
  }
  return summary + (sentences.length > 2 ? '...' : '');
}

function extractDomain(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/').filter(p => p.length > 0);
  const sourceDirs = ['src', 'packages', 'lib', 'organs', 'apps', 'components'];
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    if (sourceDirs.includes(part) && i + 1 < pathParts.length) {
      const domain = pathParts[i + 1];
      if (domain && !domain.includes('.')) {
        return domain;
      }
    }
  }
  if (normalizedPath.includes('/docs/')) {
    const docsIndex = pathParts.indexOf('docs');
    if (docsIndex >= 0 && docsIndex + 1 < pathParts.length) {
      const domain = pathParts[docsIndex + 1];
      if (domain && !['index', 'images', 'assets', 'static'].includes(domain)) {
        return domain;
      }
    }
    return 'docs';
  }
  if (normalizedPath.includes('/tests/') || normalizedPath.includes('/test/') || normalizedPath.includes('/__tests__/') ||
      normalizedPath.includes('/e2e/') || normalizedPath.includes('/evaluations/')) {
    return 'testing';
  }
  const commonDomains = ['api', 'routes', 'components', 'hooks', 'utils', 'services', 'models', 'types', 'config', 'scripts'];
  for (const part of pathParts) {
    if (commonDomains.includes(part.toLowerCase())) {
      return part.toLowerCase();
    }
  }
  const skipFolders = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage'];
  for (let i = pathParts.length - 1; i >= 0; i--) {
    const part = pathParts[i];
    if (!skipFolders.includes(part) && !part.includes('.')) {
      return part;
    }
  }
  return pathParts[0] || 'core';
}

function extractTags(content: string, filePath: string): string[] {
  const tags = new Set<string>();
  const normalizedContent = content.toLowerCase();
  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith('.tsx') || normalizedPath.endsWith('.jsx')) tags.add('react');
  if (normalizedPath.endsWith('.ts')) tags.add('typescript');
  if (normalizedPath.endsWith('.js')) tags.add('javascript');
  const importPatterns = [
    { pattern: /from\s+['"]react['"]|require\(['"]react['"]\)/i, tag: 'react' },
    { pattern: /from\s+['"]react-dom['"]|require\(['"]react-dom['"]\)/i, tag: 'react' },
    { pattern: /from\s+['"]express['"]|require\(['"]express['"]\)/i, tag: 'express' },
    { pattern: /from\s+['"]socket\.io['"]|require\(['"]socket\.io['"]\)/i, tag: 'socket.io' },
    { pattern: /from\s+['"]@?socket\.io\//i, tag: 'socket.io' },
    { pattern: /from\s+['"]openai['"]|require\(['"]openai['"]\)/i, tag: 'openai' },
    { pattern: /from\s+['"]next['"]|require\(['"]next['"]\)/i, tag: 'nextjs' },
    { pattern: /from\s+['"]vue['"]|require\(['"]vue['"]\)/i, tag: 'vue' },
    { pattern: /from\s+['"]angular['"]|require\(['"]angular['"]\)/i, tag: 'angular' },
    { pattern: /from\s+['"]@nestjs\//i, tag: 'nestjs' },
    { pattern: /from\s+['"]fastify['"]|require\(['"]fastify['"]\)/i, tag: 'fastify' },
    { pattern: /from\s+['"]koa['"]|require\(['"]koa['"]\)/i, tag: 'koa' },
    { pattern: /from\s+['"]jest['"]|require\(['"]jest['"]\)/i, tag: 'jest' },
    { pattern: /from\s+['"]vitest['"]|require\(['"]vitest['"]\)/i, tag: 'vitest' },
    { pattern: /from\s+['"]mocha['"]|require\(['"]mocha['"]\)/i, tag: 'mocha' },
    { pattern: /from\s+['"]cypress['"]|require\(['"]cypress['"]\)/i, tag: 'cypress' },
    { pattern: /from\s+['"]playwright['"]|require\(['"]playwright['"]\)/i, tag: 'playwright' },
  ];
  for (const { pattern, tag } of importPatterns) {
    if (pattern.test(content)) tags.add(tag);
  }
  if (/app\.(get|post|put|delete|patch)\(|router\.(get|post|put|delete|patch)\(/i.test(content)) tags.add('api');
  if (/io\.on\(|socket\.on\(|socket\.emit\(/i.test(content)) tags.add('websocket');
  if (/useState|useEffect|useCallback|useMemo|useRef/i.test(content)) {
    tags.add('react');
    tags.add('hooks');
  }
  if (/describe\(|it\(|test\(|expect\(/i.test(content)) tags.add('testing');
  if (/class\s+\w+.*extends.*Component/i.test(content)) tags.add('react');
  if (normalizedPath.includes('/api/') || normalizedPath.includes('/routes/')) tags.add('api');
  if (normalizedPath.includes('/components/') || normalizedPath.includes('/component/')) tags.add('components');
  if (normalizedPath.includes('/hooks/') || normalizedPath.includes('/hook/')) tags.add('hooks');
  if (normalizedPath.includes('/utils/') || normalizedPath.includes('/util/')) tags.add('utils');
  if (normalizedPath.includes('/services/') || normalizedPath.includes('/service/')) tags.add('services');
  if (normalizedPath.includes('/models/') || normalizedPath.includes('/model/')) tags.add('models');
  if (normalizedPath.includes('/types/') || normalizedPath.includes('/type/')) tags.add('types');
  if (normalizedPath.includes('.test.') || normalizedPath.includes('.spec.') || normalizedPath.includes('/test/') ||
      normalizedPath.includes('/tests/') || normalizedPath.includes('/__tests__/') || normalizedPath.includes('/e2e/')) {
    tags.add('testing');
    if (normalizedPath.includes('/e2e/')) tags.add('e2e');
  }
  if (normalizedPath.includes('dockerfile') || normalizedPath.includes('docker-compose')) tags.add('docker');
  if (normalizedPath.includes('.github/workflows') || normalizedPath.includes('ci.yml') || normalizedPath.includes('ci.yaml')) tags.add('ci');
  if (normalizedPath.includes('railway') || normalizedPath.includes('vercel') || normalizedPath.includes('netlify')) tags.add('deployment');
  return Array.from(tags).sort();
}

function calculateFreshnessScore(filePath: string): number {
  try {
    const gitLog = execSync(`git log -1 --format=%ct -- "${filePath}"`, { encoding: 'utf-8', cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (!gitLog) return 0.5;
    const commitTime = parseInt(gitLog, 10);
    const now = Math.floor(Date.now() / 1000);
    const daysSinceCommit = (now - commitTime) / (24 * 60 * 60);
    const decay = 90;
    const score = 1 / (1 + Math.exp((daysSinceCommit - decay / 2) / (decay / 10)));
    return Math.max(0, Math.min(1, score));
  } catch {
    return 0.5;
  }
}

function getGitTimestamp(filePath: string): string {
  try {
    const gitLog = execSync(`git log -1 --format=%ci -- "${filePath}"`, { encoding: 'utf-8', cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (gitLog) {
      return new Date(gitLog).toISOString();
    }
  } catch {
    // Fall through
  }
  try {
    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function generateSourceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function generateEntryId(sourcePath: string, chunkIndex: number): string {
  const fileExt = extname(sourcePath);
  const baseName = basename(sourcePath, fileExt);
  const sanitized = baseName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  const chunkNum = String(chunkIndex + 1).padStart(2, '0');
  return `doc-${sanitized}#c${chunkNum}`;
}

export class ClarityGear {
  private rootDir: string;
  private outputDir: string;
  private maxEntries: number;
  private partitionStrategy: PartitionStrategy;
  private projectName: string;

  constructor(options: ClarityGearOptions = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.outputDir = options.outputDir || this.detectOutputDir();
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.partitionStrategy = options.partitionBy || DEFAULT_PARTITION_STRATEGY;
    this.projectName = this.detectProjectName();
  }

  private detectOutputDir(): string {
    if (existsSync(join(this.rootDir, 'docs'))) {
      return join(this.rootDir, 'docs', 'index');
    }
    return join(this.rootDir, 'index');
  }

  private detectProjectName(): string {
    try {
      const packageJsonPath = join(this.rootDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson.name) {
          return packageJson.name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-');
        }
      }
    } catch {
      // Fall through
    }
    const rootName = basename(this.rootDir);
    return rootName || 'index';
  }

  static async generate(options?: ClarityGearOptions): Promise<void> {
    const gear = new ClarityGear(options);
    await gear.generateIndex();
  }

  private async generateIndex(): Promise<void> {
    console.log('🔍 Clarity Gear Index Mapper - Full Codebase');
    console.log('==============================================\n');
    console.log(`📁 Scanning codebase from ${this.rootDir}...`);
    const files = this.findIndexableFiles(this.rootDir);
    console.log(`   Found ${files.length} indexable files\n`);
    console.log('📝 Processing files...');
    const allEntries: IndexEntry[] = [];
    let processedCount = 0;
    for (const file of files) {
      const entries = this.processFile(file);
      allEntries.push(...entries);
      processedCount++;
      if (processedCount % 10 === 0) {
        console.log(`   Processed ${processedCount}/${files.length} files...`);
      }
    }
    console.log(`   Generated ${allEntries.length} chunks from ${processedCount} files\n`);
    console.log('🎯 Prioritizing and limiting entries...');
    const prioritized = this.prioritizeEntries(allEntries);
    const limited = prioritized.slice(0, this.maxEntries);
    console.log(`   Limited to ${limited.length} entries (from ${allEntries.length} total)`);
    if (limited.length < allEntries.length) {
      console.log(`   ⚠️  ${allEntries.length - limited.length} entries excluded due to size limit\n`);
    } else {
      console.log('');
    }
    const metrics = this.calculateMetrics(limited);
    console.log('📊 Quality Metrics:');
    console.log(`   Chunk count: ${metrics.chunkCount}`);
    console.log(`   Avg tokens: ${metrics.avgTokens}`);
    console.log(`   Avg freshness: ${metrics.avgFreshness}`);
    if (limited.length > 0) {
      const scores = limited.map(e => e.importance_score).sort((a, b) => b - a);
      const min = scores[scores.length - 1];
      const max = scores[0];
      const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
      const median = scores[Math.floor(scores.length / 2)];
      const high = scores.filter(s => s >= 0.7).length;
      const medium = scores.filter(s => s >= 0.5 && s < 0.7).length;
      const low = scores.filter(s => s < 0.5).length;
      console.log(`\n📈 Importance Score Distribution:`);
      console.log(`   Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}, Avg: ${avg.toFixed(2)}, Median: ${median.toFixed(2)}`);
      console.log(`   High (≥0.7): ${high}, Medium (≥0.5): ${medium}, Low (<0.5): ${low}\n`);
    } else {
      console.log('');
    }
    console.log('📄 Generating index files...');
    if (this.partitionStrategy === 'none') {
      await this.generateSingleIndex(limited);
    } else {
      await this.generatePartitionedIndex(limited);
    }
    console.log(`✅ Index generation complete!`);
  }

  private findIndexableFiles(dir: string, baseDir?: string): string[] {
    const files: string[] = [];
    const base = baseDir || this.rootDir;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = relative(base, fullPath);
        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          if (relativePath.split(/[/\\]/).some(part => EXCLUDE_DIRS.has(part))) continue;
          files.push(...this.findIndexableFiles(fullPath, base));
        } else if (entry.isFile()) {
          if (EXCLUDE_FILES.has(entry.name)) continue;
          const ext = extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not read directory ${dir}:`, error);
    }
    return files;
  }

  private chunkCodeFile(content: string, filePath: string): Array<{ text: string; title: string; type: 'function' | 'class' | 'interface' | 'type' | 'export' | 'comment'; line: number }> {
    const chunks: Array<{ text: string; title: string; type: 'function' | 'class' | 'interface' | 'type' | 'export' | 'comment'; line: number }> = [];
    const lines = content.split('\n');
    const fileName = basename(filePath);
    const functionRegex = /^(export\s+)?(async\s+)?function\s+(\w+)/;
    const classRegex = /^(export\s+)?class\s+(\w+)/;
    const interfaceRegex = /^(export\s+)?interface\s+(\w+)/;
    const typeRegex = /^(export\s+)?type\s+(\w+)/;
    const constExportRegex = /^export\s+(const|let|var)\s+(\w+)/;
    let currentChunk: string[] = [];
    let currentTitle = fileName;
    let currentType: typeof chunks[0]['type'] = 'export';
    let chunkStartLine = 0;
    let braceDepth = 0;
    let inFunction = false;
    let inClass = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;
      const funcMatch = trimmed.match(functionRegex);
      if (funcMatch && braceDepth === 0) {
        if (currentChunk.length > 0 && countTokens(currentChunk.join('\n')) >= 50) {
          chunks.push({ text: currentChunk.join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
        }
        currentChunk = [line];
        currentTitle = `function ${funcMatch[3]}`;
        currentType = 'function';
        chunkStartLine = i;
        inFunction = true;
        continue;
      }
      const classMatch = trimmed.match(classRegex);
      if (classMatch && braceDepth === 0) {
        if (currentChunk.length > 0 && countTokens(currentChunk.join('\n')) >= 50) {
          chunks.push({ text: currentChunk.join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
        }
        currentChunk = [line];
        currentTitle = `class ${classMatch[2]}`;
        currentType = 'class';
        chunkStartLine = i;
        inClass = true;
        continue;
      }
      const interfaceMatch = trimmed.match(interfaceRegex);
      if (interfaceMatch && braceDepth === 0) {
        if (currentChunk.length > 0 && countTokens(currentChunk.join('\n')) >= 50) {
          chunks.push({ text: currentChunk.join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
        }
        currentChunk = [line];
        currentTitle = `interface ${interfaceMatch[2]}`;
        currentType = 'interface';
        chunkStartLine = i;
        continue;
      }
      const typeMatch = trimmed.match(typeRegex);
      if (typeMatch && braceDepth === 0) {
        if (currentChunk.length > 0 && countTokens(currentChunk.join('\n')) >= 50) {
          chunks.push({ text: currentChunk.join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
        }
        currentChunk = [line];
        currentTitle = `type ${typeMatch[2]}`;
        currentType = 'type';
        chunkStartLine = i;
        continue;
      }
      const constMatch = trimmed.match(constExportRegex);
      if (constMatch && braceDepth === 0 && !inFunction && !inClass) {
        if (currentChunk.length > 0 && countTokens(currentChunk.join('\n')) >= 50) {
          chunks.push({ text: currentChunk.join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
        }
        currentChunk = [line];
        currentTitle = `export ${constMatch[2]}`;
        currentType = 'export';
        chunkStartLine = i;
        continue;
      }
      if (currentChunk.length > 0) {
        currentChunk.push(line);
        const chunkText = currentChunk.join('\n');
        const tokens = countTokens(chunkText);
        if (tokens > 800) {
          const splitIndex = currentChunk.findIndex((l, idx) => {
            if (idx === 0) return false;
            const prevLine = currentChunk[idx - 1].trim();
            return (prevLine === '' || prevLine.startsWith('//')) && countTokens(currentChunk.slice(0, idx).join('\n')) >= 150;
          });
          if (splitIndex > 0) {
            chunks.push({ text: currentChunk.slice(0, splitIndex).join('\n'), title: currentTitle, type: currentType, line: chunkStartLine + 1 });
            currentChunk = currentChunk.slice(splitIndex);
            chunkStartLine = i - (currentChunk.length - 1);
          }
        }
        if (braceDepth === 0 && (inFunction || inClass)) {
          inFunction = false;
          inClass = false;
        }
      } else {
        currentChunk = [line];
        currentTitle = fileName;
        currentType = 'export';
        chunkStartLine = i;
      }
    }
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join('\n');
      const tokens = countTokens(chunkText);
      if (tokens >= 50) {
        chunks.push({ text: chunkText, title: currentTitle, type: currentType, line: chunkStartLine + 1 });
      }
    }
    return chunks;
  }

  private createEntry(params: {
    id: string;
    title: string;
    domain: string;
    source: string;
    mini_summary: string;
    tags: string[];
    timestamp: string;
    freshness_score: number;
    author?: string;
    source_hash: string;
  }): IndexEntry {
    return {
      id: params.id,
      title: params.title,
      domain: params.domain,
      source: params.source,
      chunk_id: params.id,
      mini_summary: params.mini_summary,
      tags: params.tags,
      timestamp: params.timestamp,
      version: 'v1',
      status: 'active',
      freshness_score: params.freshness_score,
      importance_score: 0,
      provenance: {
        author: params.author,
        source_hash: `sha256:${params.source_hash}`,
      },
    };
  }

  private processFile(filePath: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      const relativePath = relative(this.rootDir, filePath);
      const ext = extname(filePath).toLowerCase();
      const fileName = basename(filePath);
      if (ext === '.md' || ext === '.mdx') {
        const { frontmatter, body } = extractFrontmatter(content);
        if (!body.trim()) return entries;
        let chunks = chunkMarkdown(body, 150, 800);
        if (chunks.length === 0) {
          const tokens = countTokens(body);
          if (tokens > 0) {
            chunks.push({ text: body, title: frontmatter.title || 'Document', level: 1, startLine: 0, endLine: body.split('\n').length - 1 });
          }
        }
        const maxChunks = INDEX_LIMITS.MAX_CHUNKS_PER_FILE[ext] || INDEX_LIMITS.MAX_CHUNKS_PER_FILE['.md'];
        if (chunks.length > maxChunks) {
          chunks = chunks.slice(0, maxChunks);
        }
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkText = chunk.text;
          const tokens = countTokens(chunkText);
          if (tokens < 50 || tokens > 900) continue;
          const domain = extractDomain(relativePath);
          const tags = extractTags(chunkText + ' ' + relativePath, relativePath);
          const chunkTitle = (chunk.title ?? 'Document') as string;
          let miniSummary = generateMiniSummary(chunkText, chunkTitle);
          if (countTokens(miniSummary) < 15) {
            const extendedSummary = generateMiniSummary(chunkText + ' ' + chunkTitle, chunkTitle);
            if (countTokens(extendedSummary) >= 15) {
              miniSummary = extendedSummary;
            }
          }
          if (miniSummary.length > INDEX_LIMITS.MAX_MINI_SUMMARY_LENGTH) {
            miniSummary = miniSummary.substring(0, INDEX_LIMITS.MAX_MINI_SUMMARY_LENGTH - 3) + '...';
          }
          let improvedTitle = chunk.title || 'Document';
          if (!improvedTitle || improvedTitle === 'Introduction' || improvedTitle === 'Untitled' || improvedTitle === 'Document') {
            improvedTitle = improveTitle(chunk, filePath, relativePath, miniSummary);
            if (!improvedTitle || improvedTitle === 'Introduction' || improvedTitle === 'Untitled') {
              improvedTitle = frontmatter.title || basename(filePath, extname(filePath)) || 'Document';
            }
          }
          const sourceHash = generateSourceHash(chunkText);
          const entryId = generateEntryId(relativePath, i);
          const timestamp = getGitTimestamp(filePath);
          const freshnessScore = calculateFreshnessScore(filePath);
          if (freshnessScore < INDEX_LIMITS.MIN_FRESHNESS) continue;
          const entry = this.createEntry({
            id: entryId,
            title: improvedTitle,
            domain,
            source: relativePath,
            mini_summary: miniSummary,
            tags,
            timestamp,
            freshness_score: freshnessScore,
            author: frontmatter.author || undefined,
            source_hash: sourceHash,
          });
          entry.importance_score = this.calculateImportanceScore(entry, filePath, chunkText);
          entries.push(entry);
        }
      } else if (SOURCE_CODE_EXTENSIONS.has(ext)) {
        let codeChunks = this.chunkCodeFile(content, filePath);
        const maxChunks = INDEX_LIMITS.MAX_CHUNKS_PER_FILE[ext] || INDEX_LIMITS.MAX_CHUNKS_PER_FILE['.ts'];
        if (codeChunks.length > maxChunks) {
          const important = codeChunks.filter(c => ['function', 'class', 'interface', 'type'].includes(c.type));
          const others = codeChunks.filter(c => !['function', 'class', 'interface', 'type'].includes(c.type));
          codeChunks = [...important, ...others].slice(0, maxChunks);
        }
        for (let i = 0; i < codeChunks.length; i++) {
          const chunk = codeChunks[i];
          const chunkText = chunk.text;
          const tokens = countTokens(chunkText);
          if (tokens < 50 || tokens > 900) continue;
          const domain = extractDomain(relativePath);
          const tags = extractTags(content + ' ' + relativePath, relativePath);
          const codeChunkTitle = chunk.title || fileName;
          let miniSummary = generateMiniSummary(chunkText, `${chunk.type}: ${codeChunkTitle}`);
          if (countTokens(miniSummary) < 15) {
            miniSummary = `${chunk.type} ${codeChunkTitle} in ${fileName}`;
          }
          if (miniSummary.length > INDEX_LIMITS.MAX_MINI_SUMMARY_LENGTH) {
            miniSummary = miniSummary.substring(0, INDEX_LIMITS.MAX_MINI_SUMMARY_LENGTH - 3) + '...';
          }
          const sourceHash = generateSourceHash(chunkText);
          const entryId = generateEntryId(relativePath, i);
          const timestamp = getGitTimestamp(filePath);
          const freshnessScore = calculateFreshnessScore(filePath);
          if (freshnessScore < INDEX_LIMITS.MIN_FRESHNESS) continue;
          const entry = this.createEntry({
            id: entryId,
            title: `${chunk.type}: ${codeChunkTitle}`,
            domain,
            source: relativePath,
            mini_summary: miniSummary,
            tags: [...tags, 'code', chunk.type],
            timestamp,
            freshness_score: freshnessScore,
            source_hash: sourceHash,
          });
          entry.importance_score = this.calculateImportanceScore(entry, filePath, chunkText);
          entries.push(entry);
        }
      } else if (['.json', '.yaml', '.yml'].includes(ext)) {
        const importantConfigs = ['package.json', 'tsconfig.json', 'docker-compose.yml', 'railway.json'];
        if (importantConfigs.includes(fileName)) {
          const domain = extractDomain(relativePath);
          const tags = extractTags(content + ' ' + relativePath, relativePath);
          const miniSummary = `Configuration file: ${fileName}`;
          const sourceHash = generateSourceHash(content);
          const entryId = generateEntryId(relativePath, 0);
          const timestamp = getGitTimestamp(filePath);
          const freshnessScore = calculateFreshnessScore(filePath);
          if (freshnessScore < INDEX_LIMITS.MIN_FRESHNESS) return entries;
          const entry = this.createEntry({
            id: entryId,
            title: fileName,
            domain,
            source: relativePath,
            mini_summary: miniSummary,
            tags: [...tags, 'config'],
            timestamp,
            freshness_score: freshnessScore,
            source_hash: sourceHash,
          });
          entry.importance_score = this.calculateImportanceScore(entry, filePath, content);
          entries.push(entry);
        }
      }
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error);
    }
    return entries;
  }

  private calculateImportanceScore(entry: IndexEntry, filePath: string, chunkText: string): number {
    let score = 0;
    score += entry.freshness_score * 0.3;
    const fileName = basename(filePath).toLowerCase();
    const sourceLower = entry.source.toLowerCase();
    if (fileName === 'readme.md' || fileName.includes('index') || (fileName === 'index.ts' && sourceLower.includes('/src/'))) {
      score += 0.25;
    } else if (fileName.includes('spec') || fileName.includes('architecture')) {
      score += 0.2;
    } else if (sourceLower.includes('/src/') && fileName === 'index.ts') {
      score += 0.15;
    } else {
      score += 0.05;
    }
    const importantDomains = ['specs', 'architecture', 'core'];
    const mediumDomains = ['tickets', 'ui', 'railway'];
    if (importantDomains.includes(entry.domain)) {
      score += 0.15;
    } else if (mediumDomains.includes(entry.domain)) {
      score += 0.1;
    } else {
      score += 0.05;
    }
    const isDoc = entry.source.endsWith('.md') || entry.source.endsWith('.mdx');
    if (isDoc) {
      score += 0.15;
    } else {
      const isImportantCode = entry.tags.some(t => ['function', 'class', 'interface', 'type'].includes(t));
      if (isImportantCode) {
        score += 0.12;
      } else {
        score += 0.05;
      }
    }
    const criticalTags = ['architecture', 'specs', 'api', 'state-server', 'core'];
    const importantTags = ['websocket', 'chatbot', 'server'];
    const hasCriticalTag = entry.tags.some(t => criticalTags.includes(t));
    const hasImportantTag = entry.tags.some(t => importantTags.includes(t));
    if (hasCriticalTag) {
      score += 0.1;
    } else if (hasImportantTag) {
      score += 0.05;
    }
    const tokens = countTokens(chunkText);
    if (tokens > 100) {
      score += 0.05;
    }
    return Math.min(1.0, Math.max(0.0, score));
  }

  private prioritizeEntries(entries: IndexEntry[]): IndexEntry[] {
    return entries.sort((a, b) => {
      const scoreDiff = b.importance_score - a.importance_score;
      if (Math.abs(scoreDiff) > 0.001) {
        return scoreDiff > 0 ? 1 : -1;
      }
      if (a.domain !== b.domain) {
        return a.domain.localeCompare(b.domain);
      }
      return b.timestamp.localeCompare(a.timestamp);
    });
  }

  private calculateMetrics(entries: IndexEntry[]): { chunkCount: number; avgTokens: number; coverage: number; avgFreshness: number } {
    const totalTokens = entries.reduce((sum, e) => sum + countTokens(e.mini_summary), 0);
    const avgTokens = entries.length > 0 ? totalTokens / entries.length : 0;
    const avgFreshness = entries.length > 0 ? entries.reduce((sum, e) => sum + e.freshness_score, 0) / entries.length : 0;
    return {
      chunkCount: entries.length,
      avgTokens: Math.round(avgTokens),
      coverage: 0,
      avgFreshness: Math.round(avgFreshness * 100) / 100,
    };
  }

  private yamlEntry(entry: IndexEntry, indent: number = 2): string[] {
    const spaces = ' '.repeat(indent);
    const prov = entry.provenance.author
      ? `{author: ${JSON.stringify(entry.provenance.author)}, source_hash: ${JSON.stringify(entry.provenance.source_hash)}}`
      : `{source_hash: ${JSON.stringify(entry.provenance.source_hash)}}`;
    return [
      `${spaces}- id: ${JSON.stringify(entry.id)}`,
      `${spaces}  title: ${JSON.stringify(entry.title)}`,
      `${spaces}  domain: ${JSON.stringify(entry.domain)}`,
      `${spaces}  source: ${JSON.stringify(entry.source)}`,
      `${spaces}  chunk_id: ${JSON.stringify(entry.chunk_id)}`,
      `${spaces}  mini_summary: ${JSON.stringify(entry.mini_summary)}`,
      `${spaces}  tags: [${entry.tags.map(t => JSON.stringify(t)).join(', ')}]`,
      `${spaces}  timestamp: ${JSON.stringify(entry.timestamp)}`,
      `${spaces}  version: ${JSON.stringify(entry.version)}`,
      `${spaces}  status: ${JSON.stringify(entry.status)}`,
      `${spaces}  freshness_score: ${entry.freshness_score.toFixed(2)}`,
      `${spaces}  importance_score: ${entry.importance_score.toFixed(2)}`,
      `${spaces}  provenance: ${prov}`,
    ];
  }

  private generateYAML(entries: IndexEntry[]): string {
    const lines: string[] = [
      `# ${this.projectName} - Clarity Gear Index`,
      '# Generated automatically - do not edit manually',
      '# Regenerate with: npm run index:generate',
      '',
      'entries:',
    ];
    const sorted = [...entries].sort((a, b) => {
      if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
      return b.timestamp.localeCompare(a.timestamp);
    });
    for (const entry of sorted) {
      lines.push(...this.yamlEntry(entry));
    }
    return lines.join('\n');
  }

  private partitionEntries(entries: IndexEntry[]): Map<string, IndexEntry[]> {
    const partitions = new Map<string, IndexEntry[]>();
    if (this.partitionStrategy === 'domain') {
      for (const entry of entries) {
        const domain = entry.domain;
        if (!partitions.has(domain)) {
          partitions.set(domain, []);
        }
        partitions.get(domain)!.push(entry);
      }
    } else if (this.partitionStrategy === 'importance') {
      const high: IndexEntry[] = [];
      const medium: IndexEntry[] = [];
      const low: IndexEntry[] = [];
      for (const entry of entries) {
        if (entry.importance_score >= 0.7) {
          high.push(entry);
        } else if (entry.importance_score >= 0.5) {
          medium.push(entry);
        } else {
          low.push(entry);
        }
      }
      if (high.length > 0) partitions.set('high', high);
      if (medium.length > 0) partitions.set('medium', medium);
      if (low.length > 0) partitions.set('low', low);
    }
    return partitions;
  }

  private async generateSingleIndex(entries: IndexEntry[]): Promise<void> {
    const yaml = this.generateYAML(entries);
    const outputFile = join(this.outputDir, `${this.projectName}-index.yaml`);
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(outputFile, yaml, 'utf-8');
    console.log(`✅ Index generated: ${outputFile}`);
    console.log(`   Total entries: ${entries.length}`);
    console.log(`   Size limit: ${this.maxEntries} entries`);
    console.log(`   Min freshness: ${INDEX_LIMITS.MIN_FRESHNESS}`);
    console.log(`   Max summary length: ${INDEX_LIMITS.MAX_MINI_SUMMARY_LENGTH} chars`);
    console.log(`   Format: Compact YAML (no blank lines between entries)`);
  }

  private async generatePartitionedIndex(entries: IndexEntry[]): Promise<void> {
    const partitions = this.partitionEntries(entries);
    const partitionFiles: Array<{ name: string; file: string; count: number }> = [];
    const MAX_ENTRIES_PER_PARTITION = 100;
    mkdirSync(this.outputDir, { recursive: true });
    for (const [partitionKey, partitionEntries] of partitions.entries()) {
      if (partitionEntries.length > MAX_ENTRIES_PER_PARTITION) {
        const high: IndexEntry[] = [];
        const medium: IndexEntry[] = [];
        const low: IndexEntry[] = [];
        for (const entry of partitionEntries) {
          if (entry.importance_score >= 0.7) {
            high.push(entry);
          } else if (entry.importance_score >= 0.5) {
            medium.push(entry);
          } else {
            low.push(entry);
          }
        }
        const subPartitions = [{ level: 'high', entries: high }, { level: 'medium', entries: medium }, { level: 'low', entries: low }];
        for (const subPart of subPartitions) {
          if (subPart.entries.length === 0) continue;
          const yaml = this.generateYAML(subPart.entries);
          const estimatedLines = yaml.split('\n').length;
          const fileName = `${this.projectName}-index-${partitionKey}-${subPart.level}.yaml`;
          const filePath = join(this.outputDir, fileName);
          writeFileSync(filePath, yaml, 'utf-8');
          partitionFiles.push({ name: `${partitionKey}-${subPart.level}`, file: fileName, count: subPart.entries.length });
          console.log(`   Generated sub-partition: ${fileName} (${subPart.entries.length} entries, ~${estimatedLines} lines)`);
        }
      } else {
        const yaml = this.generateYAML(partitionEntries);
        const estimatedLines = yaml.split('\n').length;
        const fileName = `${this.projectName}-index-${partitionKey}.yaml`;
        const filePath = join(this.outputDir, fileName);
        writeFileSync(filePath, yaml, 'utf-8');
        partitionFiles.push({ name: partitionKey, file: fileName, count: partitionEntries.length });
        console.log(`   Generated partition: ${fileName} (${partitionEntries.length} entries, ~${estimatedLines} lines)`);
      }
    }
    const mainIndex = this.generateMainIndex(entries, partitionFiles);
    const mainIndexFile = join(this.outputDir, `${this.projectName}-index.yaml`);
    writeFileSync(mainIndexFile, mainIndex, 'utf-8');
    console.log(`\n✅ Partitioned index generated:`);
    console.log(`   Main index: ${this.projectName}-index.yaml`);
    console.log(`   Partitions: ${partitionFiles.length}`);
    console.log(`   Total entries: ${entries.length}`);
    for (const part of partitionFiles) {
      console.log(`     - ${part.file}: ${part.count} entries`);
    }
  }

  private calculatePartitionStatistics(partitions: Array<{ name: string; file: string; count: number }>, entries: IndexEntry[]): {
    largest_partition: { name: string; entries: number };
    smallest_partition: { name: string; entries: number };
    avg_entries_per_partition: number;
    total_size_kb: number;
  } {
    if (partitions.length === 0) {
      return { largest_partition: { name: '', entries: 0 }, smallest_partition: { name: '', entries: 0 }, avg_entries_per_partition: 0, total_size_kb: 0 };
    }
    let largest = partitions[0];
    let smallest = partitions[0];
    for (const part of partitions) {
      if (part.count > largest.count) largest = part;
      if (part.count < smallest.count) smallest = part;
    }
    const totalEntries = partitions.reduce((sum, p) => sum + p.count, 0);
    const avgEntries = totalEntries / partitions.length;
    const totalSizeBytes = totalEntries * 15 * 50;
    const totalSizeKb = Math.round(totalSizeBytes / 1024);
    return {
      largest_partition: { name: largest.name, entries: largest.count },
      smallest_partition: { name: smallest.name, entries: smallest.count },
      avg_entries_per_partition: Math.round(avgEntries * 100) / 100,
      total_size_kb: totalSizeKb,
    };
  }

  private static parseYAMLEntries(content: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    const lines = content.split('\n');
    let inEntries = false;
    let currentEntry: Partial<IndexEntry> | null = null;
    let currentIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      if (line === 'entries:') {
        inEntries = true;
        continue;
      }

      if (!inEntries) continue;

      const indent = lines[i].match(/^\s*/)?.[0].length || 0;

      if (line.startsWith('- id:')) {
        if (currentEntry && currentEntry.id) {
          entries.push(this.validateAndCreateEntry(currentEntry));
        }
        currentEntry = {};
        currentIndent = indent;
        const idMatch = line.match(/id:\s*(.+)/);
        if (idMatch) {
          currentEntry.id = this.parseYAMLValue(idMatch[1].trim());
        }
      } else if (currentEntry && indent > currentIndent) {
        if (line.startsWith('title:')) {
          currentEntry.title = this.parseYAMLValue(line.replace(/^title:\s*/, ''));
        } else if (line.startsWith('domain:')) {
          currentEntry.domain = this.parseYAMLValue(line.replace(/^domain:\s*/, ''));
        } else if (line.startsWith('source:')) {
          currentEntry.source = this.parseYAMLValue(line.replace(/^source:\s*/, ''));
        } else if (line.startsWith('chunk_id:')) {
          currentEntry.chunk_id = this.parseYAMLValue(line.replace(/^chunk_id:\s*/, ''));
        } else if (line.startsWith('mini_summary:')) {
          currentEntry.mini_summary = this.parseYAMLValue(line.replace(/^mini_summary:\s*/, ''));
        } else if (line.startsWith('tags:')) {
          const tagsStr = line.replace(/^tags:\s*/, '');
          currentEntry.tags = this.parseYAMLArray(tagsStr);
        } else if (line.startsWith('timestamp:')) {
          currentEntry.timestamp = this.parseYAMLValue(line.replace(/^timestamp:\s*/, ''));
        } else if (line.startsWith('version:')) {
          currentEntry.version = this.parseYAMLValue(line.replace(/^version:\s*/, ''));
        } else if (line.startsWith('status:')) {
          currentEntry.status = this.parseYAMLValue(line.replace(/^status:\s*/, ''));
        } else if (line.startsWith('freshness_score:')) {
          currentEntry.freshness_score = parseFloat(line.replace(/^freshness_score:\s*/, ''));
        } else if (line.startsWith('importance_score:')) {
          currentEntry.importance_score = parseFloat(line.replace(/^importance_score:\s*/, ''));
        } else if (line.startsWith('provenance:')) {
          const provStr = line.replace(/^provenance:\s*/, '');
          currentEntry.provenance = this.parseYAMLProvenance(provStr);
        }
      }
    }

    if (currentEntry && currentEntry.id) {
      entries.push(this.validateAndCreateEntry(currentEntry));
    }

    return entries;
  }

  private static parseYAMLValue(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private static parseYAMLArray(value: string): string[] {
    if (!value.startsWith('[') || !value.endsWith(']')) {
      return [];
    }
    const content = value.slice(1, -1).trim();
    if (!content) return [];
    const items: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          items.push(current);
          current = '';
        } else {
          current += char;
        }
      } else if (char === ',' && !inQuotes) {
        if (current.trim()) {
          items.push(this.parseYAMLValue(current.trim()));
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current.trim()) {
      items.push(this.parseYAMLValue(current.trim()));
    }
    return items;
  }

  private static parseYAMLProvenance(value: string): { author?: string; source_hash: string } {
    if (!value.startsWith('{') || !value.endsWith('}')) {
      return { source_hash: '' };
    }
    const content = value.slice(1, -1).trim();
    const result: { author?: string; source_hash: string } = { source_hash: '' };
    const parts = content.split(',').map(p => p.trim());
    for (const part of parts) {
      if (part.startsWith('author:')) {
        result.author = this.parseYAMLValue(part.replace(/^author:\s*/, ''));
      } else if (part.startsWith('source_hash:')) {
        result.source_hash = this.parseYAMLValue(part.replace(/^source_hash:\s*/, ''));
      }
    }
    return result;
  }

  private static validateAndCreateEntry(entry: Partial<IndexEntry>): IndexEntry {
    if (!entry.id || !entry.title || !entry.domain || !entry.source) {
      throw new Error(`Invalid entry: missing required fields (id: ${entry.id}, title: ${entry.title})`);
    }
    return {
      id: entry.id,
      title: entry.title,
      domain: entry.domain,
      source: entry.source,
      chunk_id: entry.chunk_id || entry.id,
      mini_summary: entry.mini_summary || '',
      tags: entry.tags || [],
      timestamp: entry.timestamp || new Date().toISOString(),
      version: entry.version || 'v1',
      status: entry.status || 'active',
      freshness_score: entry.freshness_score ?? 0,
      importance_score: entry.importance_score ?? 0,
      provenance: entry.provenance || { source_hash: '' },
    };
  }

  private static parsePartitionFile(filePath: string): IndexEntry[] {
    if (!existsSync(filePath)) {
      console.warn(`Warning: Partition file not found: ${filePath}`);
      return [];
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      return this.parseYAMLEntries(content);
    } catch (error) {
      console.error(`Error parsing partition file ${filePath}:`, error);
      return [];
    }
  }

  static async loadIndex(indexPath?: string): Promise<IndexEntry[]> {
    const gear = new ClarityGear();
    const mainIndexPath = indexPath || join(gear.outputDir, `${gear.projectName}-index.yaml`);

    if (!existsSync(mainIndexPath)) {
      throw new Error(`Index not found: ${mainIndexPath}\nRun 'npm run index:generate' to create it.`);
    }

    const content = readFileSync(mainIndexPath, 'utf-8');

    if (content.includes('partitions:')) {
      const entries: IndexEntry[] = [];
      const lines = content.split('\n');
      let inPartitions = false;
      const partitionFiles: string[] = [];

      for (const line of lines) {
        if (line.trim() === 'partitions:') {
          inPartitions = true;
          continue;
        }
        if (inPartitions && line.trim().startsWith('file:')) {
          const fileMatch = line.match(/file:\s*(.+)/);
          if (fileMatch) {
            const fileName = this.parseYAMLValue(fileMatch[1].trim());
            const partitionPath = join(gear.outputDir, fileName);
            partitionFiles.push(partitionPath);
          }
        }
        if (inPartitions && line.trim() && !line.trim().startsWith('-') && !line.trim().startsWith('name:') && !line.trim().startsWith('file:') && !line.trim().startsWith('entry_count:')) {
          inPartitions = false;
        }
      }

      for (const partitionPath of partitionFiles) {
        const partitionEntries = this.parsePartitionFile(partitionPath);
        entries.push(...partitionEntries);
      }

      return entries;
    } else if (content.includes('entries:')) {
      return this.parseYAMLEntries(content);
    } else {
      throw new Error(`Invalid index format: no 'entries:' or 'partitions:' found in ${mainIndexPath}`);
    }
  }

  private generateMainIndex(entries: IndexEntry[], partitions: Array<{ name: string; file: string; count: number }>): string {
    const topEntries = entries.slice(0, 50);
    const stats = this.calculatePartitionStatistics(partitions, entries);
    const domainMap = new Map<string, { count: number; totalImportance: number; file: string }>();
    for (const part of partitions) {
      const baseDomain = part.name.replace(/-high$|-medium$|-low$/, '');
      if (!domainMap.has(baseDomain)) {
        domainMap.set(baseDomain, { count: 0, totalImportance: 0, file: part.file });
      }
      domainMap.get(baseDomain)!.count += part.count;
    }
    const domainImportanceMap = new Map<string, { sum: number; count: number }>();
    for (const entry of entries) {
      const baseDomain = entry.domain;
      if (!domainImportanceMap.has(baseDomain)) {
        domainImportanceMap.set(baseDomain, { sum: 0, count: 0 });
      }
      const impInfo = domainImportanceMap.get(baseDomain)!;
      impInfo.sum += entry.importance_score;
      impInfo.count++;
    }
    for (const [domain, impInfo] of domainImportanceMap.entries()) {
      if (domainMap.has(domain)) {
        domainMap.get(domain)!.totalImportance = impInfo.count > 0 ? (impInfo.sum / impInfo.count) : 0;
      }
    }
    const lines: string[] = [
      `# ${this.projectName} - Clarity Gear Index (Main)`,
      '# Generated automatically - do not edit manually',
      '# Regenerate with: npm run index:generate',
      '',
      'metadata:',
      `  total_entries: ${entries.length}`,
      `  partitions: ${partitions.length}`,
      `  generated_at: ${new Date().toISOString()}`,
      `  partition_strategy: ${this.partitionStrategy}`,
      '',
      'statistics:',
      `  largest_partition: {name: ${JSON.stringify(stats.largest_partition.name)}, entries: ${stats.largest_partition.entries}}`,
      `  smallest_partition: {name: ${JSON.stringify(stats.smallest_partition.name)}, entries: ${stats.smallest_partition.entries}}`,
      `  avg_entries_per_partition: ${stats.avg_entries_per_partition}`,
      `  total_size_kb: ${stats.total_size_kb}`,
      '',
      'partitions:',
    ];
    for (const part of partitions) {
      lines.push(`  - name: ${JSON.stringify(part.name)}`);
      lines.push(`    file: ${JSON.stringify(part.file)}`);
      lines.push(`    entry_count: ${part.count}`);
    }
    lines.push('');
    lines.push('domain_index:');
    for (const [domain, info] of domainMap.entries()) {
      lines.push(`  ${domain}: {file: ${JSON.stringify(info.file)}, count: ${info.count}, avg_importance: ${info.totalImportance.toFixed(2)}}`);
    }
    lines.push('');
    lines.push('# Top 50 most important entries (summary)');
    lines.push('summary_entries:');
    for (const entry of topEntries) {
      const topTags = entry.tags.slice(0, 3);
      const sourceBasename = basename(entry.source);
      lines.push('  - id: ' + JSON.stringify(entry.id));
      lines.push('    title: ' + JSON.stringify(entry.title));
      lines.push('    domain: ' + JSON.stringify(entry.domain));
      lines.push('    importance_score: ' + entry.importance_score.toFixed(2));
      lines.push('    source: ' + JSON.stringify(sourceBasename));
      lines.push('    top_tags: [' + topTags.map(t => JSON.stringify(t)).join(', ') + ']');
      lines.push('    partition: ' + JSON.stringify(this.partitionStrategy === 'domain' ? entry.domain : entry.importance_score >= 0.7 ? 'high' : entry.importance_score >= 0.5 ? 'medium' : 'low'));
    }
    return lines.join('\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options: { maxEntries?: number; partitionBy?: 'domain' | 'importance' | 'none'; outputDir?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-entries' && args[i + 1]) {
      options.maxEntries = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--partition-by' && args[i + 1]) {
      if (['domain', 'importance', 'none'].includes(args[i + 1])) {
        options.partitionBy = args[i + 1] as 'domain' | 'importance' | 'none';
      }
      i++;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      options.outputDir = args[i + 1];
      i++;
    }
  }
  await ClarityGear.generate(options);
}

// Execute main if this file is run directly (works with tsx in both CommonJS and ESM modes)
const isMainModule = typeof require !== 'undefined' && require.main === module;
const isDirectExecution = process.argv[1]?.endsWith('clarity-gear.ts') || 
                          process.argv[1]?.includes('clarity-gear.ts');

if (isMainModule || isDirectExecution) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
