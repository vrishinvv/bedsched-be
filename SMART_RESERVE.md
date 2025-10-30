# Smart-Reserve Endpoint Documentation

## Overview
`POST /api/allocations/smart-reserve` - Intelligently allocates multiple beds across the entire system (all locations/tents/blocks) for a group of people.

## Input Parameters

```json
{
  "phone": "1234567890",           // Required: Contact phone number
  "contactName": "John Doe",       // Optional: Contact person name
  "isFamily": true,                // Required: Determines allocation strategy
  "maleCount": 5,                  // Required: Number of males (default: 0)
  "femaleCount": 3,                // Required: Number of females (default: 0)
  "startDate": "2025-11-01",       // Required: Check-in date
  "endDate": "2025-11-05",         // Required: Check-out date
  "confirmFallback": false         // Optional: User confirmation for fallback strategies
}
```

---

## Priority Logic

### **For Families (`isFamily: true`)**

**Goal**: Keep family together in same blocks (prioritize togetherness over location proximity)

#### **Priority 1: Allocate Pairs to 'both' Blocks**
- Allocates **male-female pairs** (1 male + 1 female) to `'both'` gender blocks
- Sorts `'both'` blocks by capacity (largest first) for better pair allocation
- Example: 5 males + 3 females → 3 pairs allocated to `'both'` blocks

#### **Priority 2: Use Remaining Capacity in 'both' Blocks**
- After pairs allocated, uses leftover beds in same `'both'` blocks for individuals
- Alternates between male/female to maintain balance
- Example: After 3 pairs, 2 males left → try to fit in same `'both'` blocks

#### **Priority 3: Fallback to Single-Gender Blocks**
- Only if `'both'` blocks exhausted
- **Requires user confirmation** (`confirmFallback: true`)
- Allocates remaining males → `'male_only'` blocks
- Allocates remaining females → `'female_only'` blocks

**Family Allocation Example**:
```
Request: 8 males, 6 females (family)
Step 1: Allocate 6 pairs (12 beds) → 'both' blocks
Step 2: Allocate 2 remaining males → 'both' blocks if space available
Step 3: If no space in 'both' blocks → Ask confirmation → use 'male_only' for 2 males

Response (if confirmation needed):
{
  "error": "requires_confirmation",
  "requiresConfirmation": "need-single-gender-blocks",
  "message": "All-gender blocks are full. 2 males will be allocated to single-gender blocks. Continue?"
}
```

---

### **For Non-Families (`isFamily: false`)**

**Goal**: Maximize capacity efficiency using appropriate gender-restricted blocks

#### **Priority 1: Single-Gender Blocks Across All Locations**
- Males → `'male_only'` blocks first (all locations)
- Females → `'female_only'` blocks first (all locations)
- Sorted by location_id, tent_index, block_index (systematic fill)

#### **Priority 2: Fallback to 'both' Blocks**
- Only if single-gender blocks insufficient across all locations
- **Requires user confirmation**
- Males → `'both'` blocks
- Females → `'both'` blocks

**Non-Family Allocation Example**:
```
Request: 20 males, 10 females (non-family)
Step 1: Allocate 20 males → 'male_only' blocks (all locations)
Step 2: Allocate 10 females → 'female_only' blocks (all locations)
Step 3: If insufficient → Ask confirmation → use 'both' blocks

Response (if confirmation needed):
{
  "error": "requires_confirmation",
  "requiresConfirmation": "mixed-blocks",
  "message": "Single-gender blocks across all locations are insufficient. Fallback to mixed blocks is required."
}
```

---

## Availability Checking

### **Pre-Allocation Cleanup**
Before checking availability, the endpoint automatically cleans up expired reservations:
```sql
UPDATE allocations
SET deleted_at = NOW(), updated_at = NOW()
WHERE deleted_at IS NULL
  AND status = 'reserved'
  AND reserved_expires_at <= NOW
```

### **Occupancy Check**
Only considers **current and future allocations** (time-based booking system):
```sql
SELECT block_id, bed_number, start_date, end_date, status
FROM allocations
WHERE deleted_at IS NULL
  AND end_date >= TODAY  -- Only current/future allocations block beds
  AND (
    status = 'confirmed' OR 
    (status = 'reserved' AND reserved_expires_at > NOW)
  )
```

### **Free Bed Calculation**
For each block:
1. **Total beds**: `block.size` (e.g., 500)
2. **Occupied beds**: Set of bed_numbers from occupancy query
3. **Free beds**: Array from 1 to block.size, excluding occupied beds

Example:
```
Block ID 5: size = 500
Occupied: [1, 2, 5, 10, 50, 100]
Free beds: [3, 4, 6, 7, 8, 9, 11, ..., 49, 51, ..., 500]
Available capacity: 494 beds
```

---

## Allocation Process

### **Step-by-Step Flow**

1. **Validation**
   - Validate required fields (phone, isFamily, startDate, endDate)
   - Validate date range (start_date ≤ end_date)
   - Validate total count > 0

2. **Cleanup Expired Reservations**
   - Soft-delete all expired reservations globally
   - Prevents stale reservations from blocking availability

3. **Fetch System Data**
   - Get all locations with capacities
   - Get all tents with location mapping
   - Get all blocks with sizes and gender restrictions

4. **Calculate Occupancy**
   - Query all active allocations (end_date >= today)
   - Build occupancy map per block
   - Calculate free beds per block

5. **Apply Allocation Strategy**
   - **Family**: Maximize pairs in 'both' blocks → use remaining 'both' → fallback to single-gender
   - **Non-Family**: Use single-gender blocks → fallback to 'both' blocks

6. **Validation & Confirmation**
   - Check if sufficient beds available
   - If fallback needed and `confirmFallback=false` → Return confirmation request
   - If `confirmFallback=true` → Proceed with fallback strategy

7. **Batch Insert**
   - Generate unique `batch_id` for the group
   - Set `reserved_expires_at` (default: 7 hours from now)
   - Insert allocations in batches (500 rows at a time to avoid param limits)
   - Wrap in transaction (BEGIN/COMMIT)

8. **Error Handling**
   - **23P01 (Exclusion Constraint)**: Date range overlap detected → Rollback + return 409 error
   - Other errors → Rollback + return 500 error

---

## Response Types

### **Success Response**
```json
{
  "ok": true,
  "batchId": "batch_1730000000_abc123",
  "locationId": 1,  // Single location ID if all beds in one location, else null
  "items": [
    {
      "locationId": 1,
      "tentIndex": 1,
      "blockIndex": 2,
      "bedNumber": 45,
      "gender": "Male"
    },
    {
      "locationId": 1,
      "tentIndex": 1,
      "blockIndex": 2,
      "bedNumber": 46,
      "gender": "Female"
    }
    // ... more items
  ]
}
```

### **Requires Confirmation Response**
```json
{
  "error": "requires_confirmation",
  "requiresConfirmation": "need-single-gender-blocks",  // or "mixed-blocks"
  "message": "All-gender blocks are full. 2 males will be allocated to single-gender blocks. Continue?",
  "preview": [
    {
      "locationId": 1,
      "tentIndex": 1,
      "blockIndex": 2,
      "bedNumber": 45,
      "gender": "Male"
    }
    // ... preview of allocation plan
  ]
}
```

**Confirmation Types**:
- `"need-single-gender-blocks"`: Family allocation needs single-gender blocks for some members
- `"mixed-blocks"`: Non-family allocation needs 'both' blocks (single-gender blocks full)
- `"split"`: Family cannot be kept fully together (deprecated, not currently returned)

### **Conflict Response**
```json
{
  "error": "overlapping_allocation",
  "message": "One or more beds are already booked for the requested dates. The beds may have been reserved by someone else while you were completing your booking.",
  "detail": "Key (location_id, tent_id, block_id, bed_number, daterange(start_date, end_date, '[]'::text))=(1, 5, 20, 45, [2025-11-01,2025-11-05]) conflicts with existing key..."
}
```

### **Insufficient Beds Response**
```json
{
  "error": "insufficient_beds",
  "message": "Unable to satisfy reservation with current capacity"
}
```

### **Validation Error Response**
```json
{
  "error": "missing_required_fields"  // or "invalid_date_range", "invalid_count"
}
```

---

## Key Features

### **Atomic Batch Operations**
- All allocations in a single request share one `batch_id`
- Easy to track, confirm, or delete an entire group booking
- Example: `batch_1730000000_abc123`

### **Transaction Safety**
- Entire allocation wrapped in database transaction
- Automatic rollback on any error
- Prevents partial allocations

### **Conflict Detection**
- PostgreSQL exclusion constraint prevents overlapping date ranges
- Catches conflicts during insertion (23P01 error)
- Returns user-friendly error message

### **Reservation TTL**
- Default: 7 hours (configurable via `RESERVATION_TTL_HOURS`)
- Auto-expires if not confirmed
- `reserved_expires_at = NOW + 7 hours`

### **Extensive Logging**
All operations logged with:
- Total allocations found per block
- Free capacity per block
- Allocation plan by block (males, females, bed numbers)
- Batch ID, timestamp, phone, date range
- Conflict details with bed numbers and dates

Example log:
```
[SMART-RESERVE] Checking current and future allocations
[SMART-RESERVE] Found 245 total active allocations across all blocks
[SMART-RESERVE] Block occupancy counts: Block 1: 50 beds occupied, Block 2: 30 beds occupied, ...
[SMART-RESERVE] Block 1 (L1 T1 B1): 500 total, 50 occupied, 450 free
[FAMILY ALLOC] Males: 8, Females: 6, Pairs needed: 6
[FAMILY ALLOC] Pairs we can allocate: 6
[SMART-RESERVE] Allocation plan by block:
  L1 T1 B2: 6M + 6F = 12 beds (bed numbers: 1, 2, 3, 4, 5...)
  L1 T1 B3: 2M + 0F = 2 beds (bed numbers: 10, 11)
```

---

## Usage Examples

### **Family Booking (Success)**
```bash
POST /api/allocations/smart-reserve
{
  "phone": "9876543210",
  "contactName": "Sharma Family",
  "isFamily": true,
  "maleCount": 4,
  "femaleCount": 4,
  "startDate": "2025-11-01",
  "endDate": "2025-11-05"
}

# Response: All 8 people allocated to 'both' blocks (4 pairs)
{
  "ok": true,
  "batchId": "batch_1730000000_xyz789",
  "locationId": 1,
  "items": [...]  // 8 items
}
```

### **Family Booking (Needs Confirmation)**
```bash
POST /api/allocations/smart-reserve
{
  "phone": "9876543210",
  "contactName": "Large Family",
  "isFamily": true,
  "maleCount": 50,
  "femaleCount": 50,
  "startDate": "2025-11-01",
  "endDate": "2025-11-05"
}

# Response: 'both' blocks insufficient, needs single-gender blocks
{
  "error": "requires_confirmation",
  "requiresConfirmation": "need-single-gender-blocks",
  "message": "All-gender blocks are full. 30 males and 30 females will be allocated to single-gender blocks. Continue?",
  "preview": [...]
}

# User confirms - retry with confirmFallback
POST /api/allocations/smart-reserve
{
  "phone": "9876543210",
  "contactName": "Large Family",
  "isFamily": true,
  "maleCount": 50,
  "femaleCount": 50,
  "startDate": "2025-11-01",
  "endDate": "2025-11-05",
  "confirmFallback": true  // Added confirmation
}

# Response: Success with mixed allocation
{
  "ok": true,
  "batchId": "batch_1730000000_def456",
  "locationId": null,  // Multiple locations used
  "items": [...]  // 100 items
}
```

### **Non-Family Booking**
```bash
POST /api/allocations/smart-reserve
{
  "phone": "8765432109",
  "contactName": "College Group",
  "isFamily": false,
  "maleCount": 30,
  "femaleCount": 0,
  "startDate": "2025-11-10",
  "endDate": "2025-11-12"
}

# Response: All males allocated to 'male_only' blocks
{
  "ok": true,
  "batchId": "batch_1730100000_ghi012",
  "locationId": 2,
  "items": [...]  // 30 items, all gender: "Male"
}
```

---

## Time-Based Booking System

**Critical**: This endpoint implements a **time-based booking system**, NOT permanent allocation.

### **Bed Availability Rule**
A bed is **AVAILABLE** if:
- No confirmed allocation with `end_date >= TODAY`, AND
- No active reservation (or all reservations expired)

A bed is **UNAVAILABLE** if:
- Confirmed allocation exists with `end_date >= TODAY`, OR
- Active reservation exists with `reserved_expires_at > NOW`

### **Timeline Example**
```
Bed #45 in Block 2:
├─ Oct 25: Person A books for Nov 1-5
│  └─ ✅ ALLOWED (bed free)
│
├─ Oct 26: Person B tries to book for Nov 6-10
│  └─ ❌ REJECTED (Person A's end_date=Nov 5 >= Oct 26)
│
├─ Nov 6: Person B tries to book for Nov 7-10
│  └─ ✅ ALLOWED (Person A's end_date=Nov 5 < Nov 6, bed free)
│
└─ Nov 7: Bed #45 shows occupied by Person B
```

### **Multiple Bookings on Same Bed**
Same bed can be booked by **different people** for **different date ranges**, as long as:
1. Date ranges don't overlap
2. No current/future booking exists at the time of allocation attempt

---

## Database Details

### **Batch ID Format**
```javascript
batch_${timestamp}_${random6chars}
// Example: batch_1730000000_abc123
```

### **Reservation Expiration**
```javascript
const expiresAt = new Date(Date.now() + (RESERVATION_TTL_HOURS * 60 * 60 * 1000));
// Default: 7 hours from now
```

### **Batch Insert Strategy**
- Inserts 500 rows per batch to avoid PostgreSQL parameter limit (65535)
- Formula: 500 rows × 15 params = 7500 params per batch (safe)
- Large allocations (>500 beds) split into multiple INSERT statements

### **Exclusion Constraint**
```sql
EXCLUDE USING gist (
  location_id WITH =,
  tent_id WITH =,
  block_id WITH =,
  bed_number WITH =,
  daterange(start_date, end_date, '[]') WITH &&
) WHERE (deleted_at IS NULL)
```
- Prevents overlapping allocations on same bed
- Error code: 23P01
- Triggers rollback and returns 409 Conflict

---

## Error Scenarios

### **Scenario 1: Race Condition**
Two users simultaneously try to reserve same bed:
1. Both read occupancy (bed shows free)
2. User A inserts allocation (succeeds)
3. User B tries to insert allocation → **23P01 error** → Rollback → 409 response

### **Scenario 2: Expired Reservations Blocking**
Without cleanup, expired reservations would block new allocations:
1. Old reservation expired 2 hours ago
2. New allocation attempt → bed shows occupied → fails
3. **Solution**: Cleanup step soft-deletes expired reservations first

### **Scenario 3: Insufficient Capacity**
Request exceeds total system capacity:
1. Request: 10,000 beds
2. System capacity: 6,000 beds (all free)
3. Response: `insufficient_beds` error

### **Scenario 4: Date Range Validation**
Invalid date range provided:
1. Request: startDate = "2025-11-10", endDate = "2025-11-05"
2. Validation fails: start > end
3. Response: `invalid_date_range` error

---

## Best Practices

1. **Always handle confirmation flow**: Check for `requires_confirmation` in response
2. **Show preview to user**: Display `preview` array before requesting confirmation
3. **Retry with confirmFallback**: After user confirms, retry with `confirmFallback: true`
4. **Handle conflicts gracefully**: 409 errors mean someone else booked the bed → prompt user to retry
5. **Store batch_id**: Use for confirming, searching, or deleting entire group booking
6. **Respect reservation TTL**: User has 7 hours to confirm reservation before auto-expiry
