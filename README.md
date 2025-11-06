# Clarity Gear

**Autonomous semantic index generator for any codebase**

Clarity Gear automatically discovers, chunks, and indexes your entire codebase into a structured semantic map. No configuration needed - just copy and run.

## Quick Start

### Installation

#### Option 1: Clone the repository

```bash
git clone https://github.com/yourusername/clarity-gear.git
cd clarity-gear
npm install
```

#### Option 2: Copy to your project

Copy the `clarity-gear/` folder to your project's `scripts/` directory:

```bash
cp -r clarity-gear/ /path/to/your/project/scripts/
cd /path/to/your/project/scripts/clarity-gear
npm install
```

### Usage

#### As a standalone project

```bash
npm run index:generate
```

Or directly:

```bash
tsx clarity-gear.ts
```

#### In your project

Add to your `package.json`:

```json
{
  "scripts": {
    "index:generate": "tsx scripts/clarity-gear/clarity-gear.ts"
  }
}
```

Then run:

```bash
npm run index:generate
```

## What It Does

Clarity Gear automatically:

1. **Scans** your entire codebase (source code, docs, configs)
2. **Chunks** files intelligently (by functions, classes, headers, etc.)
3. **Detects** domains from folder structure
4. **Detects** tags from imports and code patterns
5. **Generates** mini-summaries for each chunk
6. **Ranks** entries by importance score
7. **Outputs** structured YAML index files

## Auto-Detection

### Project Name
- Detected from `package.json` → `name` field
- Fallback: root folder name

### Output Directory
- If `docs/` exists → `docs/index/`
- Otherwise → `./index/`

### Domains
Auto-detected from file paths:
- `src/api/` → domain: `api`
- `docs/architecture/` → domain: `architecture`
- `packages/ui/` → domain: `ui`
- `tests/` → domain: `testing`

### Tags
Auto-detected from:
- **File extensions**: `.tsx` → `react`, `.ts` → `typescript`
- **Imports**: `import from 'express'` → `express`, `api`
- **Code patterns**: `app.get()` → `api`, `useState` → `react`, `hooks`
- **File structure**: `/components/` → `components`, `/api/` → `api`

## Options

### Command Line

```bash
# Basic usage
npm run index:generate

# With options
npm run index:generate -- --max-entries 800 --partition-by domain --output-dir ./docs/index
```

### Programmatic

```typescript
import { ClarityGear } from './clarity-gear.js';

await ClarityGear.generate({
  maxEntries: 800,              // Max entries in index (default: 600)
  partitionBy: 'domain',        // 'domain' | 'importance' | 'none' (default: 'domain')
  outputDir: './docs/index',    // Auto-detected if not provided
  rootDir: process.cwd()        // Auto-detected if not provided
});
```

Or if using from another project:

```typescript
import { ClarityGear } from './scripts/clarity-gear/clarity-gear.js';

await ClarityGear.generate({
  maxEntries: 800,
  partitionBy: 'domain',
  outputDir: './docs/index',
  rootDir: process.cwd()
});
```

## Output

### Partitioned Index (Default)

When using `partitionBy: 'domain'`:

```
docs/index/
  ├── {project-name}-index.yaml          # Main index (metadata + top 50 entries)
  ├── {project-name}-index-{domain}.yaml # Domain partitions
  └── {project-name}-index-{domain}-{importance}.yaml # Sub-partitions (if >100 entries)
```

### Single File Index

When using `partitionBy: 'none'`:

```
docs/index/
  └── {project-name}-index.yaml          # All entries in one file
```

## Index Structure

Each entry contains:

```yaml
- id: "doc-file-name#c01"
  title: "Descriptive title"
  domain: "auto-detected-domain"
  source: "relative/path/to/file"
  chunk_id: "doc-file-name#c01"
  mini_summary: "Concise summary of the chunk"
  tags: ["react", "typescript", "api"]
  timestamp: "2025-11-06T10:00:00Z"
  version: "v1"
  status: "active"
  freshness_score: 0.95
  importance_score: 0.82
  provenance:
    source_hash: "sha256:..."
```

## File Types Supported

- **Source Code**: `.ts`, `.tsx`, `.js`, `.jsx` (chunked by functions, classes, interfaces)
- **Documentation**: `.md`, `.mdx` (chunked by headers)
- **Configuration**: `.json`, `.yaml`, `.yml` (selective indexing)

## Size Limits

- **Max entries**: 600 (configurable)
- **Max chunks per file**: Docs: 10, Code: 5, Configs: 1
- **Min freshness**: 0.2 (very old files excluded)
- **Max mini_summary length**: 200 characters

## Importance Scoring

Entries are automatically ranked by a composite importance score (0-1) based on:

- **Freshness** (0-0.3): More recent = higher score
- **File importance** (0-0.25): README, index.ts, SPEC files prioritized
- **Domain importance** (0-0.15): specs, architecture prioritized
- **Content type** (0-0.15): Documentation prioritized
- **Tag importance** (0-0.1): Critical tags boost score
- **Chunk quality** (0-0.05): Well-formed chunks get bonus

Top entries by importance are included in the index.

## Pre-commit Hook

To auto-regenerate the index on commit, add to `.git/hooks/pre-commit`:

```bash
#!/bin/sh
CHANGED=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(md|mdx|ts|tsx|js|jsx|json|yaml|yml)$')
if [ -n "$CHANGED" ]; then
  npm run index:generate > /dev/null 2>&1
  INDEX_FILE=$(find docs/index index -name "*-index.yaml" -type f 2>/dev/null | head -1)
  if [ -n "$INDEX_FILE" ] && [ -n "$(git diff "$INDEX_FILE" 2>/dev/null)" ]; then
    git add "$INDEX_FILE"
    git add docs/index/*-index-*.yaml index/*-index-*.yaml 2>/dev/null || true
  fi
fi
```

## Requirements

- Node.js >= 18.0.0
- TypeScript
- `tsx` (for running TypeScript directly)

Install dependencies:

```bash
npm install --save-dev tsx typescript @types/node
```

## Files

- `clarity-gear.ts` - Main ClarityGear class with all functionality (chunking, summarization, auto-detection, CLI entry point)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.

