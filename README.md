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
- **CRITICAL**: Reservations are shown/counted based on `reserved_expires_at > NOW`, **NOT** `end_date`
  - A reservation with `end_date = Nov 3` but `reserved_expires_at = Nov 4 6:00 AM` should still be visible and counted until Nov 4 6:00 AM
  - This is because reservations are temporary holds that expire based on creation time, not the booking dates
  - At midnight when TODAY changes, reservations don't disappear - they only disappear when `reserved_expires_at` is reached

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
- `name`: Guest contact name (optional)
- `phone`: Guest phone number (required, 10 digits)
- `aadhar_number`: Guest Aadhar number (optional, 12 digits stored without spaces)
- `gender`: Guest gender ('Male', 'Female', 'Other')
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
todaySQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE`
tomorrowSQL = `((NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + INTERVAL '1 day')::DATE`
nowIST = `NOW()` // For timestamp comparisons - keep as UTC
```

**CRITICAL: Timestamp Comparison Rules**

Database timestamps (`reserved_expires_at`, `created_at`, `updated_at`, `deleted_at`) are stored as **UTC timestamps with timezone**.

When comparing timestamps:
```sql
-- ✅ CORRECT: Compare UTC to UTC
WHERE reserved_expires_at > NOW()

-- ❌ WRONG: Comparing UTC timestamp to IST timestamp without timezone
WHERE reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata')
-- This creates a timestamp WITHOUT timezone, causing incorrect comparisons!
```

**Why This Matters:**
- `NOW()` returns UTC timestamp: `2025-11-04 00:30:00+00`
- `NOW() AT TIME ZONE 'Asia/Kolkata'` returns: `2025-11-04 06:00:00` (no timezone info)
- Comparing `reserved_expires_at (UTC with TZ)` against `06:00:00 (no TZ)` causes PostgreSQL to make incorrect assumptions
- Result: Reservations appear expired when they're not, or vice versa

**When to use each helper:**
- Use `todaySQL` and `tomorrowSQL` for **DATE comparisons** (start_date, end_date)
- Use `NOW()` directly for **TIMESTAMP comparisons** (reserved_expires_at, created_at)

### Reservation Cleanup Logic

Reservations are **soft-deleted** (deleted_at set to NOW()) when **EITHER** condition is met:

1. **TTL Expiry**: `reserved_expires_at <= NOW()`
   - Reservation has exceeded its time-to-live (7-hour window by default)
   - Checked as UTC-to-UTC comparison

2. **Booking Date Past**: `end_date < todaySQL`
   - The booking's end date has passed
   - No point keeping reservation if the dates are already past

**Cleanup happens opportunistically** when allocation-related endpoints are called:
- Smart reserve
- Single bed allocate
- Bulk allocate  
- Edit allocation
- Manual cleanup endpoint

Whichever condition comes first triggers the soft-delete.

todaySQL = `(CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`
tomorrowSQL = `((CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day')::date`
nowIST = `(NOW() AT TIME ZONE 'Asia/Kolkata')`
```

## API Endpoints

### Smart Reserve (POST /api/allocations/smart-reserve)

**Purpose**: Intelligently allocate multiple beds across blocks/tents/locations

**Request Body**:
```javascript
{
  phone: "9876543210",           // Required: 10-digit phone number
  contactName: "John Doe",       // Optional: Guest name
  aadharNumber: "123456789012",  // Optional: 12-digit Aadhar (sent without spaces)
  isFamily: true,                // Required: Family preference flag
  maleCount: 2,                  // Required: Number of males
  femaleCount: 2,                // Required: Number of females
  startDate: "2025-11-03",       // Required: Check-in date (YYYY-MM-DD)
  endDate: "2025-11-24",         // Required: Check-out date (YYYY-MM-DD)
  confirmFallback: false         // Optional: Auto-confirm fallback strategies
}
```

**Validation Rules**:
- Phone: Exactly 10 digits
- Aadhar: Exactly 12 digits (if provided)
- Date Range: Must be within November 3-24, 2025
- Start date ≤ End date
- Total count (maleCount + femaleCount) > 0

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

**Request Body** (POST/PATCH):
```javascript
{
  name: "John Doe",              // Optional: Guest name
  phone: "9876543210",           // Required: 10-digit phone number
  aadharNumber: "123456789012",  // Optional: 12-digit Aadhar (sent without spaces)
  gender: "Male",                // Required: 'Male', 'Female', or 'Other'
  startDate: "2025-11-03",       // Required: YYYY-MM-DD
  endDate: "2025-11-24",         // Required: YYYY-MM-DD
  status: "confirmed"            // Optional: 'confirmed' or 'reserved' (default: 'confirmed')
}
```

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

**Request Body**:
```javascript
{
  name: "Group Leader",          // Optional: Contact name
  phone: "9876543210",           // Required: 10-digit phone number
  aadharNumber: "123456789012",  // Optional: 12-digit Aadhar (sent without spaces)
  maleCount: 10,                 // Required: Number of male beds
  femaleCount: 5,                // Required: Number of female beds
  startDate: "2025-11-03",       // Required: YYYY-MM-DD
  endDate: "2025-11-24"          // Required: YYYY-MM-DD
}
```

**Process**:
1. Cleanup expired reservations in the block
2. Find occupied beds (end_date >= TODAY)
3. Calculate available beds
4. Validate sufficient capacity
5. Allocate males first, then females
6. Validate gender restrictions per allocation
7. All beds in the group share the same contact details (name, phone, aadhar)

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
  - Includes: name, phone, aadharNumber, gender, startDate, endDate, status
- **Only includes allocations where end_date >= TODAY**

#### getLocationTents(locationId)
Returns tents in a location with stats per tent

#### getTentBlocks(locationId, tentIndex)
Returns blocks in a tent with stats per block

#### getBlockDetail(locationId, tentIndex, blockIndex)
Returns block with:
- Block metadata (size, gender_restriction)
- `beds` object with current/future allocations
  - Includes: name, phone, aadharNumber, gender, startDate, endDate, status
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

### ❌ Bug: Filtering reservations by end_date
```javascript
// WRONG - Reservations disappear at midnight even if not expired
WHERE deleted_at IS NULL
  AND end_date >= TODAY
  AND status = 'reserved'
// Problem: A reservation with end_date=Nov 3 but reserved_expires_at=Nov 4 6AM
// will disappear at midnight on Nov 4, even though it hasn't expired yet!
```

### ✅ Correct: Filter confirmed and reserved differently
```javascript
// CORRECT - Separate logic for confirmed vs reserved
WHERE deleted_at IS NULL
  AND (
    (status = 'confirmed' AND end_date >= TODAY)
    OR (status = 'reserved' AND reserved_expires_at > NOW)
  )
// Confirmed: Use end_date (booking dates matter)
// Reserved: Use reserved_expires_at (expiry time matters, not booking dates)
```

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
  AND (
    (status = 'confirmed' AND end_date >= TODAY)
    OR (status = 'reserved' AND reserved_expires_at > NOW)
  )
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
// For reservations
COUNT(*) FILTER (WHERE status = 'reserved' AND reserved_expires_at > NOW)
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
FRONTEND_URL=http://localhost:3000 # CORS allowed origin
NODE_ENV=development              # Environment mode
```

## Database Migrations

### Migration Files
Located in `/migrations/` directory, executed in order:

1. **001_add_role_column.sql**: Added `role` column to users table
2. **002_create_location_users.sql**: 
   - Added `location_id` column to users table with FK to locations
   - Created 60 location-specific users (10 per location)
   - Updated role constraint to include 'location_user'
3. **003_add_aadhar_number.sql**:
   - Added `aadhar_number VARCHAR(12)` column to allocations table
   - Nullable field for optional Aadhar input

### Running Migrations
```bash
# Using psql with connection string from .env
psql $DATABASE_URL -f migrations/001_add_role_column.sql
psql $DATABASE_URL -f migrations/002_create_location_users.sql
psql $DATABASE_URL -f migrations/003_add_aadhar_number.sql
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

### Roles & Permissions

#### Role Types
1. **admin**: Full system access
   - Can view and manage all locations
   - Access to all admin pages (departures, reserved, edit, confirm)
   - No location restrictions

2. **location_user**: Location-scoped administrator
   - Full admin capabilities within assigned location only
   - Can view only their assigned location on dashboard
   - Can access admin pages filtered to their location
   - Cannot view or access other locations
   - Location assignment stored in `users.location_id`

3. **dashboard**: Read-only viewer
   - Read-only access + smart-reserve capability
   - No location restrictions

#### User Credentials by Location
Each location has 10 dedicated users with pattern `{location_abbr}_{1-10}`:

- **West Gate North** (location_id=1): `wgn_1` to `wgn_10`
- **East Gate North** (location_id=2): `egn_1` to `egn_10`
- **South Gate** (location_id=3): `sg_1` to `sg_10`
- **Dharma Pravaha** (location_id=4): `dp_1` to `dp_10`
- **Zone 5** (location_id=5): `z5_1` to `z5_10`
- **VIP Area** (location_id=6): `vip_1` to `vip_10`

All location user passwords: `password123`

### Database Schema

#### users table
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  CHECK (role IN ('admin', 'location_user', 'dashboard'))
);
```

Key constraints:
- `location_id` is required for `location_user` role
- `location_id` is NULL for `admin` and `dashboard` roles

### JWT & Authentication Flow

#### Login Response (POST /api/login)
```javascript
{
  token: "jwt_token",
  user: {
    username: "wgn_1",
    role: "location_user",
    locationId: 1  // Only present for location_user role
  }
}
```

#### JWT Payload
```javascript
{
  username: "wgn_1",
  role: "location_user",
  locationId: 1,  // Only for location_user
  iat: 1234567890
}
```

#### Cookie-Based Auth
- Token stored in HTTP-only cookie: `bedsched_token`
- Automatically sent with requests
- Extracted by `getUserFromRequest(req)` middleware

### Middleware
Global middleware checks JWT token or cookies:
```javascript
const user = getUserFromRequest(req); 
// Returns: { username, role, locationId? }
```

### Frontend Location Filtering

Location-based users see filtered data on all pages:

1. **Dashboard (/)**: Shows only their assigned location card
2. **Admin Pages**: All filtered by `locationId`
   - `/admin/departures`: Only their location's departures
   - `/admin/reserved`: Only their location's reservations
   - `/admin/edit`: Search limited to their location
   - `/admin/confirm`: Search limited to their location
3. **Location Cards**: 
   - Admin: All locations clickable
   - Location user: Only their location clickable
   - Others: Not shown/grayed out

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
-- Get occupied bed numbers (CRITICAL: Different logic for confirmed vs reserved)
SELECT bed_number 
FROM allocations 
WHERE block_id = $1 
  AND deleted_at IS NULL 
  AND (
    (status = 'confirmed' AND end_date >= TODAY)
    OR (status = 'reserved' AND reserved_expires_at > NOW)
  )

-- Then in JavaScript: filter out occupied from 1..block.size
```

### Check if bed is available
```sql
SELECT EXISTS (
  SELECT 1 FROM allocations
  WHERE block_id = $1 
    AND bed_number = $2
    AND deleted_at IS NULL
    AND (
      (status = 'confirmed' AND end_date >= TODAY)
      OR (status = 'reserved' AND reserved_expires_at > NOW)
    )
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

1. **Use different filters for confirmed vs reserved allocations**
   - Confirmed: Filter by `end_date >= TODAY` (booking dates matter)
   - Reserved: Filter by `reserved_expires_at > NOW()` (expiry time matters, not booking dates)
   - Never filter reservations by `end_date` - they can have past/future booking dates but still be active
2. **Use NOW() for timestamp comparisons, not (NOW() AT TIME ZONE 'Asia/Kolkata')**
   - Database timestamps are stored as UTC with timezone
   - `reserved_expires_at > NOW()` ✅ CORRECT
   - `reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata')` ❌ WRONG (timezone mismatch)
3. **Clean up expired reservations** before allocation operations
4. **Use IST timezone helpers ONLY for DATE operations** (todaySQL, tomorrowSQL)
   - `end_date >= ${todaySQL}` ✅ for DATE comparisons
   - `reserved_expires_at > NOW()` ✅ for TIMESTAMP comparisons
5. **Soft-delete** instead of hard-delete (set deleted_at)
6. **Log comprehensive details** for debugging conflicts (batch_id, date ranges, occupancy)
7. **Validate gender restrictions** at block level before allocation
8. **Use transactions** for multi-step operations (PATCH endpoints)
9. **Ensure consistency** between aggregate stats queries and detail queries - both must use same filtering logic

## Frontend Integration Notes

### UI Formatting & Display

#### Aadhar Number Display
- **Backend Storage**: 12 digits without spaces (e.g., `"123456789012"`)
- **Frontend Display**: Formatted with spaces every 4 digits (e.g., `"1234 5678 9012"`)
- **Input**: Real-time formatting as user types, maxLength=14 (12 digits + 2 spaces)
- **Validation**: Optional field, but if provided must be exactly 12 digits
- **API Payload**: Sent to backend without spaces

#### Phone Number Handling
- **Format**: Exactly 10 digits, no spaces or special characters
- **Input**: `inputMode="numeric"`, `maxLength={10}`
- **Validation**: Required field, regex `/^\d{10}$/`
- **Search**: Buttons disabled until 10 digits entered

#### Date Range Restrictions
- **Allowed Range**: November 3-24, 2025
- **Implementation**: `min="2025-11-03"` and `max="2025-11-24"` on date inputs
- **Validation**: Both frontend and backend enforce this range
- **Helper Text**: "Nov 3-24, 2025" displayed below date pickers

### Allocation Display Rules
- Bed grid shows allocations where `end_date >= TODAY`
- Past allocations (end_date < TODAY) are hidden from UI
- Stats reflect current + future allocations only
- Reservations show countdown timer based on `reserved_expires_at`

### Location-Based Access Control
Frontend filters data based on user role and `locationId`:
- **Admin**: No filtering, sees all locations
- **Location User**: Filtered to their `locationId` only
  - Dashboard shows only their location card
  - Admin pages (departures, reserved, edit, confirm) filter by `locationId`
  - Location cards for other locations are not clickable
- **Dashboard**: No filtering, but read-only access