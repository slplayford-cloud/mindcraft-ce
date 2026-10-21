import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AdvancementTracker } from '../src/agent/advancements.js';

const language = {
    'advancements.story.mine_stone.title': 'Stone Age',
    'advancements.story.mine_stone.description': 'Mine Stone with your new Pickaxe',
    'advancements.story.upgrade_tools.title': 'Getting an Upgrade',
    'advancements.story.upgrade_tools.description': 'Construct a better Pickaxe',
};

function makeBot() {
    return { _client: new EventEmitter(), registry: { language } };
}

function translated(key) {
    return { type: 'compound', value: { translate: { type: 'string', value: key } } };
}

function advancement(parentId, name) {
    return {
        parentId,
        displayData: {
            title: translated(`advancements.story.${name}.title`),
            description: translated(`advancements.story.${name}.description`),
            flags: { hidden: 0 },
        },
        requirements: [[name]],
    };
}

function progress(key, criterion, time) {
    return { key, value: [{ criterionIdentifier: criterion, criterionProgress: time }] };
}

const loginPacket = {
    reset: true,
    advancementMapping: [
        { key: 'minecraft:story/root', value: { ...advancement(undefined, 'root'), requirements: [['crafting_table']] } },
        { key: 'minecraft:story/mine_stone', value: advancement('minecraft:story/root', 'mine_stone') },
        { key: 'minecraft:story/upgrade_tools', value: advancement('minecraft:story/mine_stone', 'upgrade_tools') },
        { key: 'minecraft:recipes/misc/stick', value: { parentId: undefined, displayData: undefined, requirements: [['has_planks']] } },
    ],
    identifiers: [],
    progressMapping: [
        progress('minecraft:story/root', 'crafting_table', 1000n),
        progress('minecraft:story/mine_stone', 'mine_stone', undefined),
        progress('minecraft:story/upgrade_tools', 'upgrade_tools', undefined),
        progress('minecraft:recipes/misc/stick', 'has_planks', 900n),
    ],
};

test('login packet populates translated advancements', () => {
    const bot = makeBot();
    const tracker = new AdvancementTracker(bot);
    bot._client.emit('advancements', loginPacket);

    assert.equal(tracker.received, true);
    assert.equal(tracker.defs['minecraft:story/mine_stone'].title, 'Stone Age');
    assert.equal(tracker.isDone('minecraft:story/root'), true);
    assert.equal(tracker.isDone('minecraft:story/mine_stone'), false);
    // root and recipe unlocks are not shown
    assert.deepEqual(tracker.getCompleted(), []);
    assert.deepEqual(tracker.getAvailable(), ['minecraft:story/mine_stone']);
});

test('incremental progress completes an advancement and unlocks its child', () => {
    const bot = makeBot();
    const tracker = new AdvancementTracker(bot);
    bot._client.emit('advancements', loginPacket);
    bot._client.emit('advancements', {
        reset: false,
        advancementMapping: [],
        identifiers: [],
        progressMapping: [progress('minecraft:story/mine_stone', 'mine_stone', 2000n)],
    });

    assert.deepEqual(tracker.getCompleted(), ['minecraft:story/mine_stone']);
    assert.deepEqual(tracker.getAvailable(), ['minecraft:story/upgrade_tools']);
    assert.equal(tracker.format('minecraft:story/upgrade_tools'), 'Getting an Upgrade (Construct a better Pickaxe)');
});

test('revoking progress un-completes an advancement', () => {
    const bot = makeBot();
    const tracker = new AdvancementTracker(bot);
    bot._client.emit('advancements', loginPacket);
    bot._client.emit('advancements', {
        reset: false,
        advancementMapping: [],
        identifiers: [],
        progressMapping: [progress('minecraft:story/root', 'crafting_table', undefined)],
    });

    assert.equal(tracker.isDone('minecraft:story/root'), false);
    // tab roots never gate their children
    assert.deepEqual(tracker.getAvailable(), ['minecraft:story/mine_stone']);
});

test('multi-criteria advancements need every requirement group', () => {
    const bot = makeBot();
    const tracker = new AdvancementTracker(bot);
    bot._client.emit('advancements', {
        reset: true,
        advancementMapping: [{
            key: 'minecraft:adventure/adventuring_time',
            value: { ...advancement(undefined, 'adventuring_time'), requirements: [['plains'], ['desert'], ['forest']] },
        }],
        identifiers: [],
        progressMapping: [{
            key: 'minecraft:adventure/adventuring_time',
            value: [
                { criterionIdentifier: 'plains', criterionProgress: 1n },
                { criterionIdentifier: 'desert', criterionProgress: undefined },
                { criterionIdentifier: 'forest', criterionProgress: 2n },
            ],
        }],
    });

    assert.equal(tracker.isDone('minecraft:adventure/adventuring_time'), false);
    assert.deepEqual(tracker.getRemainingCriteria('minecraft:adventure/adventuring_time'), ['desert']);
});
