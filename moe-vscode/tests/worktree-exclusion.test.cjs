'use strict';
// Per-task worktrees live at <project root>/.worktrees/<taskId> and are full checkouts.
// JetBrains excludes the folder (WorktreeExclusion.kt); VS Code does it declaratively through
// contributes.configurationDefaults. VS Code MERGES object defaults into its core default, so each
// object carries only the .worktrees key. files.exclude stays untouched: the Explorer still lists it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

function configurationDefaults() {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const defaults = pkg.contributes && pkg.contributes.configurationDefaults;
    assert.ok(
        defaults !== null && typeof defaults === 'object' && !Array.isArray(defaults),
        'package.json contributes.configurationDefaults must be an object'
    );
    return defaults;
}

test('files.watcherExclude keeps per-task worktrees out of the file watcher', () => {
    assert.deepEqual(configurationDefaults()['files.watcherExclude'], { '**/.worktrees/**': true });
});

test('search.exclude keeps per-task worktrees out of search and quick open', () => {
    assert.deepEqual(configurationDefaults()['search.exclude'], { '**/.worktrees': true });
});

test('files.exclude is not contributed, so the Explorer still lists .worktrees', () => {
    assert.equal(Object.hasOwn(configurationDefaults(), 'files.exclude'), false);
});
