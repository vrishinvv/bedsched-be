# BedSched Backend - Detailed Documentation

## Overview
BedSched is a bed allocation and reservation management system for managing guest accommodations across multiple locations, tents, and blocks. The system supports time-based bookings with automatic conflict prevention.

## Core Business Logic

### Allocation Model: Time-Based Booking System

**CRITICAL: This is a time-based booking system, NOT a permanent allocation system.**

#### Key Principle
A bed can be allocated to **multiple different people** for **different date ranges**, as long as the date ranges don't overlap AND there's no current/future booking at the time of allocation attempt.

#### Availability Rule
At the **moment of booking**, a bed is considered **UNAVAILABLE** if:
- It has a confirmed allocation with `end_date >= TODAY` (current or future stay), OR
- It has an active reservation with `reserved_expires_at > NOW` (not expired)

A bed is **AVAILABLE** if:
- No confirmed allocation with `end_date >= TODAY`, AND
- No active reservation (either none exists, or all reservations have expired)

#### Timeline Example
```
Bed #1 Timeline:
├─ Dec 25: Someone books for Jan 1-5 (Person A) 
│  └─ ✅ ALLOWED (bed has no current/future allocation)
│
├─ Dec 26: Someone tries to book for Jan 6-10 (Person B)
│  └─ ❌ REJECTED (Person A's allocation exists with end_date=Jan 5 >= Dec 26)
│
├─ Jan 6: Someone tries to book for Jan 7-10 (Person B)
│  └─ ✅ ALLOWED (Person A's end_date=Jan 5 < Jan 6, bed is free)
│
└─ Jan 7: Bed #1 shows as "Occupied by Person B"
```

### Allocation vs Reservation

#### Confirmed Allocation (status = 'confirmed')
- Permanent booking
- Defined by `start_date` and `end_date`
- No expiration timestamp
- Becomes "past" when `end_date < TODAY`
- Shown in UI when `end_date >= TODAY`

#### Reservation (status = 'reserved')
- Temporary hold (default: 7 hours via `RESERVATION_TTL_HOURS`)
- Has `reserved_expires_at` timestamp
- Auto-expires if not confirmed before expiration
- Can be confirmed (converted to status='confirmed')
- Cleaned up automatically by various endpoints

### Data Model

#### Hierarchy
```
Location (e.g., "West Gate North", capacity: 6000)
  └─ Tent (size: 2000 beds, tent_index: 1, 2, 3...)
      └─ Block (size: 500 beds, block_index: 1, 2, 3, 4)
          └─ Bed (bed_number: 1-500)
              └─ Allocation (one allocation per bed at a time for current/future dates)
```

#### Database Schema Key Points

**allocations table**:
- `location_id`: References locations(id)
- `tent_id`: References tents(id) - nullable for legacy location-level allocations
- `block_id`: References blocks(id) - nullable for legacy location-level allocations
- `bed_number`: Integer (1 to block.size or location.capacity)
- `status`: 'reserved' or 'confirmed'
- `reserved_expires_at`: Timestamp, only for status='reserved'
- `start_date`, `end_date`: Date range for the stay
- `deleted_at`: Soft delete timestamp
- **Exclusion Constraint**: Prevents overlapping allocations on same bed
  ```sql
  EXCLUDE USING gist (
    location_id WITH =,
    tent_id WITH =,
    block_id WITH =,
    bed_number WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (deleted_at IS NULL)
  ```

**blocks table**:
- `gender_restriction`: 'male_only' | 'female_only' | 'both'
- Controls which genders can be allocated to this block

### Timezone Handling

**All dates/times use IST (Asia/Kolkata, UTC+5:30)**

Helper constants in `common/helpers.js`:
```javascript
todaySQL = `(CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`
tomorrowSQL = `((CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day')::date`
nowIST = `(NOW() AT TIME ZONE 'Asia/Kolkata')`
```

## API Endpoints

### Smart Reserve (POST /api/allocations/smart-reserve)

**Purpose**: Intelligently allocate multiple beds across blocks/tents/locations

**Family Allocation Strategy**:
1. **Priority 1**: Maximize male-female pairs in 'both' blocks (keeps families together)
2. **Priority 2**: Use remaining capacity in 'both' blocks for individuals
3. **Priority 3**: Use single-gender blocks (male_only/female_only) only as fallback

**Non-Family Allocation Strategy**:
1. Allocate to single-gender blocks first (male_only for males, female_only for females)
2. Fall back to 'both' blocks if single-gender blocks are full

**Availability Check**:
```sql
-- Checks for beds with end_date >= TODAY (current or future bookings)
SELECT block_id, bed_number 
FROM allocations
WHERE deleted_at IS NULL
  AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
  AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW AT TIME ZONE 'Asia/Kolkata'))
```

**Cleanup Before Allocation**:
- Soft-deletes expired reservations globally before checking availability
- Ensures stale reservations don't block new bookings

### Single Bed Allocation Endpoints

#### Location-Level (Legacy)
- `POST /api/locations/:id/beds/:bedNumber/allocate`
- `PATCH /api/locations/:id/beds/:bedNumber` (edit allocation)
- `DELETE /api/locations/:id/beds/:bedNumber` (soft-delete)

#### Block-Level (Recommended)
- `POST /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber/allocate`
- `PATCH /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber` (edit)
- `DELETE /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber` (soft-delete)

**Allocation Check Logic** (both levels):
```javascript
// Before inserting, check if bed has current/future allocation
SELECT id FROM allocations
WHERE block_id = $1  -- or location_id for location-level
  AND bed_number = $2
  AND deleted_at IS NULL
  AND end_date >= TODAY
  AND (status = 'confirmed' OR (status = 'reserved' AND NOT expired))
LIMIT 1

// If found → Reject with 409 error
// If not found → Allow allocation
```

### Bulk Allocation (POST /api/locations/:id/tents/:tent/blocks/:block/beds/bulk-allocate)

**Purpose**: Allocate multiple beds in a single block

**Process**:
1. Cleanup expired reservations in the block
2. Find occupied beds (end_date >= TODAY)
3. Calculate available beds
4. Validate sufficient capacity
5. Allocate males first, then females
6. Validate gender restrictions per allocation

### GET Endpoints (common/helpers.js)

**Important**: All GET endpoints filter by `end_date >= TODAY` to show only current and future allocations.

#### getLocationsWithStats()
Returns all locations with:
- `allocatedCount`: COUNT of confirmed allocations with end_date >= today
- `freeingTomorrow`: COUNT of allocations ending tomorrow
- `reservedCount`: COUNT of active (not expired) reservations

#### getLocationDetail(locationId)
Returns location with:
- Stats (allocated, freeingTomorrow, reserved)
- `beds` object: Key = bed_number, Value = allocation data
- **Only includes allocations where end_date >= TODAY**

#### getLocationTents(locationId)
Returns tents in a location with stats per tent

#### getTentBlocks(locationId, tentIndex)
Returns blocks in a tent with stats per block

#### getBlockDetail(locationId, tentIndex, blockIndex)
Returns block with:
- Block metadata (size, gender_restriction)
- `beds` object with current/future allocations
- **Only includes allocations where end_date >= TODAY**

### Admin Endpoints

#### Search Allocations (GET /api/allocations/search)
- Search by phone number
- Returns all allocations (past, current, future) for audit purposes
- Grouped by batch_id

#### Confirm Reservations (POST /api/allocations/confirm)
- Converts status='reserved' to status='confirmed'
- Removes `reserved_expires_at` timestamp

#### Cleanup Expired (POST /api/allocations/cleanup-expired)
- Manual trigger to soft-delete expired reservations
- Soft-delete: Sets `deleted_at = NOW()`

## Critical Bugs to Avoid

### ❌ Bug: Checking ALL allocations regardless of end_date
```javascript
// WRONG - This prevents reusing beds after checkout
WHERE deleted_at IS NULL
  AND (status = 'confirmed' OR ...)
// No end_date filter → bed permanently unavailable
```

### ✅ Correct: Check only current/future allocations
```javascript
// CORRECT - Allows bed reuse after checkout
WHERE deleted_at IS NULL
  AND end_date >= TODAY
  AND (status = 'confirmed' OR ...)
```

### ❌ Bug: Stats counting past allocations
```javascript
// WRONG - Inflates allocated count
COUNT(*) FILTER (WHERE status = 'confirmed')
```

### ✅ Correct: Stats counting current/future only
```javascript
// CORRECT - Accurate availability
COUNT(*) FILTER (WHERE end_date >= TODAY AND status = 'confirmed')
```

### ❌ Bug: Not cleaning up expired reservations before allocation
- Expired reservations can cause false "bed occupied" errors
- Always cleanup before checking availability

## Environment Variables

```bash
PORT=3001                          # Server port
DATABASE_URL=postgresql://...      # PostgreSQL connection string
JWT_SECRET=your-secret-key         # JWT signing key
RESERVATION_TTL_HOURS=7           # Reservation expiration (default: 7 hours)
```

## Seeding Data (POST /api/seed)

Creates sample data:
- 6 locations with varying capacities (1500-6000 beds)
- Tents (2000 beds each) + remainder tents
- Blocks (500 beds each) + remainder blocks
- Gender restrictions: Pattern based on block_index % 3
  - block_index % 3 = 1 → male_only
  - block_index % 3 = 2 → female_only
  - block_index % 3 = 0 → both
- Sample allocations: 10% occupancy per block

## Authentication & Authorization

### Roles
- **admin**: Full access to all endpoints
- **dashboard**: Read-only + smart-reserve access

### Middleware
Global middleware checks JWT token or cookies:
```javascript
const user = getUserFromRequest(req); // Returns { username, role }
```

## Common Queries

### Find all beds in a block (with occupancy status)
```sql
SELECT 
  b.size as total_beds,
  COUNT(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.end_date >= TODAY) as occupied
FROM blocks b
LEFT JOIN allocations a ON a.block_id = b.id
WHERE b.id = $1
GROUP BY b.id, b.size
```

### Find available beds in a block
```sql
-- Get occupied bed numbers
SELECT bed_number 
FROM allocations 
WHERE block_id = $1 
  AND deleted_at IS NULL 
  AND end_date >= TODAY
  AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW))

-- Then in JavaScript: filter out occupied from 1..block.size
```

### Check if bed is available
```sql
SELECT EXISTS (
  SELECT 1 FROM allocations
  WHERE block_id = $1 
    AND bed_number = $2
    AND deleted_at IS NULL
    AND end_date >= TODAY
    AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW))
) as is_occupied
```

## Error Handling

### Exclusion Constraint Violation (23P01)
- Occurs when trying to insert overlapping allocation
- Means: Another allocation exists for same bed with overlapping dates
- Response: 409 Conflict with user-friendly message

### Common Error Codes
- `bed_already_allocated`: Bed has current/future allocation
- `insufficient_beds`: Not enough free beds for bulk request
- `gender_restriction_violation`: Gender doesn't match block restriction
- `overlapping_allocation`: Date ranges overlap (from exclusion constraint)

## Best Practices for Future Development

1. **Always check end_date >= TODAY** when determining bed availability
2. **Clean up expired reservations** before allocation operations
3. **Use IST timezone helpers** for all date/time operations
4. **Soft-delete** instead of hard-delete (set deleted_at)
5. **Log comprehensive details** for debugging conflicts (batch_id, date ranges, occupancy)
6. **Validate gender restrictions** at block level before allocation
7. **Use transactions** for multi-step operations (PATCH endpoints)

## Frontend Integration Notes

- Bed grid shows allocations where `end_date >= TODAY`
- Past allocations (end_date < TODAY) are hidden from UI
- Stats reflect current + future allocations only
- Reservations show countdown timer based on `reserved_expires_at`