import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { createLearning } from '../db/repositories/learningsRepo.ts'
import { extractManualLearning } from '../learnings/extractLearning.ts'
import { parseUnifiedDiff } from '../review/diffParser.ts'
import { reviewDiff } from '../review/reviewDiff.ts'

describe('diff review', () => {
  it('parses changed files, added imports, and dependency additions', () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,3 @@
+import moment from "moment"
+const x = require('left-pad')
 export const app = 1
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,5 +1,6 @@
 "dependencies": {
+  "moment": "^2.0.0",
   "zod": "^3.0.0"
 }
`
    const parsed = parseUnifiedDiff(diff)
    assert.deepEqual(parsed.files.map((file) => file.path), ['src/app.ts', 'package.json'])
    assert(parsed.addedImports.some((item) => item.source === 'moment'))
    assert(parsed.addedImports.some((item) => item.source === 'left-pad'))
    assert(parsed.addedDependencies.some((item) => item.name === 'moment'))
  })

  it('uses package.json diff context to classify dependency additions', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,6 +10,7 @@
   "devDependencies": {
+    "vitest": "^3.0.0",
     "typescript": "^5.8.3"
   }
`

    const parsed = parseUnifiedDiff(diff)

    assert.deepEqual(parsed.addedDependencies, [{ path: 'package.json', name: 'vitest', kind: 'devDependencies' }])
  })

  it('detects forbidden imports and generated file edits', async () => {
    const { db, storage } = await setupDb()
    try {
      const avoidMoment = extractManualLearning('Do not use moment.js, use date-fns')
      const generated = extractManualLearning('Never edit src/generated/**')
      assert(avoidMoment && generated)
      createLearning(db, 'review-repo', avoidMoment)
      createLearning(db, 'review-repo', generated)

      const result = reviewDiff(db, {
        repoKey: 'review-repo',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -0,0 +1 @@
+import moment from "moment"
diff --git a/src/generated/client.ts b/src/generated/client.ts
--- a/src/generated/client.ts
+++ b/src/generated/client.ts
@@ -1 +1,2 @@
 export const client = 1
+export const manual = 2
`,
      })

      assert(result.warnings.some((warning) => warning.ruleKind === 'forbidden_import' && warning.pattern === 'moment'))
      assert(result.warnings.some((warning) => warning.ruleKind === 'forbidden_path_edit' && warning.path === 'src/generated/client.ts'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('warns when required test paths are missing', async () => {
    const { db, storage } = await setupDb()
    try {
      const testing = extractManualLearning('Always add tests under test/api')
      assert(testing)
      createLearning(db, 'review-repo', testing)

      const missing = reviewDiff(db, {
        repoKey: 'review-repo',
        diff: `diff --git a/src/routes/invoices.ts b/src/routes/invoices.ts
--- a/src/routes/invoices.ts
+++ b/src/routes/invoices.ts
@@ -1 +1,2 @@
 export const route = 1
+export const filter = 2
`,
      })
      assert(missing.warnings.some((warning) => warning.ruleKind === 'required_test_path'))

      const present = reviewDiff(db, {
        repoKey: 'review-repo',
        diff: `diff --git a/src/routes/invoices.ts b/src/routes/invoices.ts
--- a/src/routes/invoices.ts
+++ b/src/routes/invoices.ts
@@ -1 +1,2 @@
 export const route = 1
+export const filter = 2
diff --git a/test/api/invoices.test.ts b/test/api/invoices.test.ts
--- a/test/api/invoices.test.ts
+++ b/test/api/invoices.test.ts
@@ -0,0 +1 @@
+test('filter', () => {})
`,
      })
      assert(!present.warnings.some((warning) => warning.ruleKind === 'required_test_path'))
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})

async function setupDb() {
  const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-review-db-'))
  const db = await openCodeIntelligenceDb(storage)
  return { db, storage }
}
