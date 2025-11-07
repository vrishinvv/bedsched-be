#!/bin/bash

# Script to clear all data and reseed the database
# Requires environment variables: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT

echo "========================================="
echo "Database Reset & Seed Script"
echo "========================================="
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "❌ Error: psql is not installed or not in PATH"
    exit 1
fi

# Check required environment variables
if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "❌ Error: Missing required environment variables"
    echo "   Required: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME"
    echo "   Optional: DB_PORT (defaults to 5432)"
    exit 1
fi

# Set default port if not provided
DB_PORT=${DB_PORT:-5432}

echo "📦 Database Configuration:"
echo "   Host: $DB_HOST"
echo "   Port: $DB_PORT"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo ""

# Step 1: Clear all data
echo "🗑️  Step 1: Clearing all existing data..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f clear_all_data.sql

if [ $? -eq 0 ]; then
    echo "✅ Data cleared successfully"
else
    echo "❌ Failed to clear data"
    exit 1
fi

echo ""

# Step 2: Call seed endpoint
echo "🌱 Step 2: Seeding database with new data..."
echo "   (Waiting for backend server to be ready...)"

# Try to seed (assumes backend is running on port 3001)
SEED_RESPONSE=$(curl -s -X POST http://localhost:3001/api/seed -H "Content-Type: application/json")

if echo "$SEED_RESPONSE" | grep -q "success.*true"; then
    echo "✅ Database seeded successfully!"
    echo ""
    echo "📊 Seed Summary:"
    echo "$SEED_RESPONSE" | jq '.' 2>/dev/null || echo "$SEED_RESPONSE"
else
    echo "❌ Failed to seed database"
    echo "Response: $SEED_RESPONSE"
    exit 1
fi

echo ""
echo "========================================="
echo "✅ Reset & Seed Complete!"
echo "========================================="
