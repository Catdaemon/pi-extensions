import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatFileProgress } from '../pi/progressWidget.ts'

describe('code intelligence progress widget', () => {
  it('does not show incremental changed-file progress as a fraction of the whole repo', () => {
    assert.equal(formatFileProgress('changedFilesIndex', 2, 2000), 'Changed files 2')
  })

  it('shows full repo indexing as processed over total files', () => {
    assert.equal(formatFileProgress('fullRepoIndex', 2, 2000), 'Files 2/2000')
  })
})
