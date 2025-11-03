-- Create location-specific users for each location
-- Each location gets 10 users with auto-generated abbreviations
-- Username format: {abbreviation}_{number}, password same as username
-- Role: location_user (restricted to their location only)

-- Helper function to generate abbreviation from location name
CREATE OR REPLACE FUNCTION generate_abbreviation(location_name TEXT) 
RETURNS TEXT AS $$
DECLARE
  words TEXT[];
  abbr TEXT := '';
  word TEXT;
BEGIN
  -- Split name by spaces and take first letter of each word
  words := string_to_array(lower(location_name), ' ');
  FOREACH word IN ARRAY words
  LOOP
    abbr := abbr || substring(word, 1, 1);
  END LOOP;
  RETURN abbr;
END;
$$ LANGUAGE plpgsql;

-- Insert 10 users for each location
DO $$
DECLARE
  loc RECORD;
  abbr TEXT;
  i INT;
  user_name TEXT;
BEGIN
  -- Loop through all locations
  FOR loc IN SELECT id, name FROM locations ORDER BY id
  LOOP
    -- Generate abbreviation (e.g., "West Gate North" -> "wgn")
    abbr := generate_abbreviation(loc.name);
    
    -- Create 10 users for this location
    FOR i IN 1..10
    LOOP
      user_name := abbr || '_' || i;
      
      INSERT INTO users (username, password, role, location_id)
      VALUES (user_name, user_name, 'location_user', loc.id)
      ON CONFLICT (username) DO NOTHING;
      
      RAISE NOTICE 'Created user: % for location: %', user_name, loc.name;
    END LOOP;
  END LOOP;
END $$;

-- Drop the helper function
DROP FUNCTION generate_abbreviation(TEXT);

-- Display created users
SELECT u.id, u.username, u.role, l.name as location_name
FROM users u
JOIN locations l ON u.location_id = l.id
WHERE u.role = 'location_user'
ORDER BY l.id, u.username;
