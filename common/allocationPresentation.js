export function mapAllocationRowToBedData(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    emergencyPhone: row.emergency_phone,
    gender: row.gender || 'Other',
    startDate: row.start_date_str,
    endDate: row.end_date_str,
    status: row.status,
    reservedExpiresAt: row.reserved_expires_at ? row.reserved_expires_at.toISOString() : null,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    accommodationCategory: row.accommodation_category,
    categorySource: row.category_source,
    verifiedCategories: row.verified_categories || [],
    saiConnectId: row.sai_connect_id || null,
    saiConnectAge: row.sai_connect_age == null ? null : Number(row.sai_connect_age),
    caretakerForAllocationId: row.caretaker_for_allocation_id ? Number(row.caretaker_for_allocation_id) : null,
    caretakerForName: row.caretaker_for_name || null,
    caretakerForBedNumber: row.caretaker_for_bed_number == null ? null : Number(row.caretaker_for_bed_number),
  };
}
