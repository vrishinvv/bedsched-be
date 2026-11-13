import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSplits2026Plan, createTentBlocks } from '../common/splits2026.js';

test('createTentBlocks splits large tents into ~250-bed blocks and merges small remainders', () => {
  assert.deepEqual(createTentBlocks(1800), [250, 250, 250, 250, 250, 250, 300]);
  assert.deepEqual(createTentBlocks(450), [250, 200]);
  assert.deepEqual(createTentBlocks(500), [250, 250]);
  assert.deepEqual(createTentBlocks(2200), [250, 250, 250, 250, 250, 250, 250, 250, 200]);
  assert.deepEqual(createTentBlocks(850), [250, 250, 250, 100]);
  assert.deepEqual(createTentBlocks(375), [250, 125]);
  assert.deepEqual(createTentBlocks(572), [250, 322]);
  assert.deepEqual(createTentBlocks(300), [300]);
  assert.deepEqual(createTentBlocks(350), [250, 100]);
  assert.deepEqual(createTentBlocks(900), [250, 250, 250, 150]);
});

test('buildSplits2026Plan builds the exact 5 locations and 17,377 total beds', () => {
  const plan = buildSplits2026Plan();
  assert.equal(plan.length, 5);
  assert.deepEqual(
    plan.map((l) => ({ name: l.name, shortcode: l.shortcode, capacity: l.capacity, tents: l.tents.length })),
    [
      { name: 'New Block A', shortcode: 'nba', capacity: 1800, tents: 5 },
      { name: 'New Block B', shortcode: 'nbb', capacity: 1580, tents: 5 },
      { name: 'Shivam Enclave', shortcode: 'she', capacity: 5800, tents: 5 },
      { name: 'Sundaram Enclave', shortcode: 'sue', capacity: 6397, tents: 11 },
      { name: 'Dharmakshetra Enclave', shortcode: 'de', capacity: 1800, tents: 2 },
    ]
  );

  const totalBeds = plan.reduce((sum, l) => sum + l.capacity, 0);
  assert.equal(totalBeds, 17377);
});

test('New Block A has First–Fifth Floors with Room 1–4 (160, 20, 20, 160), female_only, sevadal', () => {
  const nba = buildSplits2026Plan().find((l) => l.name === 'New Block A');
  assert.deepEqual(
    nba.tents.map((t) => t.name),
    ['First Floor', 'Second Floor', 'Third Floor', 'Fourth Floor', 'Fifth Floor']
  );

  for (const floor of nba.tents) {
    assert.equal(floor.size, 360);
    assert.deepEqual(
      floor.blocks.map((b) => ({
        name: b.name,
        size: b.size,
        gender: b.genderRestriction,
        cats: b.allowedCategories,
      })),
      [
        { name: 'Room 1', size: 160, gender: 'female_only', cats: ['sevadal'] },
        { name: 'Room 2', size: 20, gender: 'female_only', cats: ['sevadal'] },
        { name: 'Room 3', size: 20, gender: 'female_only', cats: ['sevadal'] },
        { name: 'Room 4', size: 160, gender: 'female_only', cats: ['sevadal'] },
      ]
    );
  }
});

test('New Block B maps Floor 1 to Room 0, 4, 5, 6, 7 and Floors 2–5 to Room 0–9, male_only, sevadal', () => {
  const nbb = buildSplits2026Plan().find((l) => l.name === 'New Block B');
  assert.deepEqual(
    nbb.tents.map((t) => ({ name: t.name, size: t.size, rooms: t.blocks.length })),
    [
      { name: 'First Floor', size: 300, rooms: 5 },
      { name: 'Second Floor', size: 320, rooms: 10 },
      { name: 'Third Floor', size: 320, rooms: 10 },
      { name: 'Fourth Floor', size: 320, rooms: 10 },
      { name: 'Fifth Floor', size: 320, rooms: 10 },
    ]
  );

  assert.deepEqual(
    nbb.tents[0].blocks.map((b) => [b.name, b.size, b.genderRestriction, b.allowedCategories]),
    [
      ['Room 0', 160, 'male_only', ['sevadal']],
      ['Room 4', 30, 'male_only', ['sevadal']],
      ['Room 5', 40, 'male_only', ['sevadal']],
      ['Room 6', 40, 'male_only', ['sevadal']],
      ['Room 7', 30, 'male_only', ['sevadal']],
    ]
  );

  for (const floor of nbb.tents.slice(1)) {
    assert.deepEqual(
      floor.blocks.map((b) => [b.name, b.size, b.genderRestriction, b.allowedCategories]),
      [
        ['Room 0', 30, 'male_only', ['sevadal']],
        ['Room 1', 40, 'male_only', ['sevadal']],
        ['Room 2', 40, 'male_only', ['sevadal']],
        ['Room 3', 30, 'male_only', ['sevadal']],
        ['Room 4', 30, 'male_only', ['sevadal']],
        ['Room 5', 40, 'male_only', ['sevadal']],
        ['Room 6', 40, 'male_only', ['sevadal']],
        ['Room 7', 30, 'male_only', ['sevadal']],
        ['Room 8', 20, 'male_only', ['sevadal']],
        ['Room 9', 20, 'male_only', ['sevadal']],
      ]
    );
  }
});

test('Shivam, Sundaram, and Dharmakshetra Enclaves match strict gender and category tags from the 2026 sheet', () => {
  const plan = buildSplits2026Plan();
  const shivam = plan.find((l) => l.name === 'Shivam Enclave');
  assert.deepEqual(
    shivam.tents.map((t) => [t.name, t.size, t.blocks[0].genderRestriction, t.blocks[0].allowedCategories]),
    [
      ['Tent 1', 1800, 'female_only', ['delegate', 'sevadal']],
      ['Tent 2', 450, 'male_only', ['sevadal']],
      ['Tent 3', 500, 'male_only', ['sevadal']],
      ['Tent 4', 2200, 'both', ['devotee']],
      ['Tent 5', 850, 'both', ['devotee']],
    ]
  );

  const sundaram = plan.find((l) => l.name === 'Sundaram Enclave');
  assert.deepEqual(
    sundaram.tents.map((t) => [t.name, t.size, t.blocks[0].genderRestriction, t.blocks[0].allowedCategories]),
    [
      ['Tent 1', 950, 'female_only', ['delegate']],
      ['Tent 2', 800, 'male_only', ['sevadal']],
      ['Tent 3', 375, 'female_only', ['delegate']],
      ['Tent 4', 572, 'male_only', ['sevadal']],
      ['Tent 5', 500, 'male_only', ['sevadal']],
      ['Tent 6', 500, 'male_only', ['sevadal']],
      ['Tent 7', 800, 'male_only', ['sevadal']],
      ['Tent 8', 600, 'female_only', ['devotee']],
      ['Tent 9', 300, 'male_only', ['devotee']],
      ['Tent 10', 350, 'both', ['devotee']],
      ['Tent 11', 650, 'male_only', ['devotee']],
    ]
  );

  const dharmakshetra = plan.find((l) => l.name === 'Dharmakshetra Enclave');
  assert.deepEqual(
    dharmakshetra.tents.map((t) => [t.name, t.size, t.blocks[0].genderRestriction, t.blocks[0].allowedCategories]),
    [
      ['Tent 1', 900, 'both', ['delegate']],
      ['Tent 2', 900, 'female_only', ['sevadal']],
    ]
  );
});
