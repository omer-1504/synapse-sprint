-- 1. Create the game state table
CREATE TABLE IF NOT EXISTS public.brain_game (
    id bigint PRIMARY KEY,
    current_target int NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Insert the initial game state row (ID = 1, starting at target = 1)
INSERT INTO public.brain_game (id, current_target)
VALUES (1, 1)
ON CONFLICT (id) DO NOTHING;

-- 2. Create the board tiles table
CREATE TABLE IF NOT EXISTS public.brain_tiles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    value int NOT NULL,
    expression text NOT NULL,
    owner_name text,
    owner_color text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Seed the 100 math tiles dynamically with expressions matching values 1 to 100
DO $$
DECLARE
    v int;
    r int;
    expr text;
BEGIN
    -- Clear existing tiles if any and restart the identity sequence
    TRUNCATE TABLE public.brain_tiles RESTART IDENTITY;
    
    -- Create a temporary table to hold sequential tiles
    CREATE TEMP TABLE temp_tiles (
        value int,
        expression text
    ) ON COMMIT DROP;
    
    FOR v IN 1..100 LOOP
        -- Pick a random offset from 1 to 10
        r := floor(random() * 10 + 1)::int;
        
        -- Generate a simple math expression that evaluates to `v`
        IF random() > 0.5 THEN
            expr := (v + r)::text || ' - ' || r::text;
        ELSE
            -- Make sure we don't subtract more than `v` if we want positive terms
            r := floor(random() * (v - 1) + 1)::int;
            IF v = 1 THEN
                expr := '5 - 4';
            ELSE
                expr := (v - r)::text || ' + ' || r::text;
            END if;
        END IF;
        
        INSERT INTO temp_tiles (value, expression)
        VALUES (v, expr);
    END LOOP;
    
    -- Insert into brain_tiles in a random order
    INSERT INTO public.brain_tiles (value, expression)
    SELECT value, expression FROM temp_tiles ORDER BY random();
END $$;

-- 4. Enable Realtime replication for these tables
-- Run this to add tables to the supabase_realtime publication list
ALTER PUBLICATION supabase_realtime ADD TABLE public.brain_game;
ALTER PUBLICATION supabase_realtime ADD TABLE public.brain_tiles;
