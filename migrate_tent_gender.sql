-- Migration script to add gender_restriction column to existing tents table
-- Run this script if you have an existing database to add the new column

-- Add the column with default value
ALTER TABLE tents 
ADD COLUMN IF NOT EXISTS gender_restriction TEXT NOT NULL DEFAULT 'both';

-- Add the check constraint
ALTER TABLE tents 
ADD CONSTRAINT check_gender_restriction 
CHECK (gender_restriction IN ('male_only', 'female_only', 'both'));