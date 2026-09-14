-- ====================================================================
-- MIGRATION: 20260913195804_security_definer_lockdown.sql
-- DESCRIPTION: P0 Security Hardening:
--              1. Identify all SECURITY DEFINER functions in public schema.
--              2. Set search_path = '' for all mutable search_path functions.
--              3. Revoke EXECUTE from PUBLIC, anon, and authenticated.
--              4. Ensure service_role retains EXECUTE.
-- ====================================================================

DO $$
DECLARE
    f record;
BEGIN
    -- 1. Fix mutable search_path on all SECURITY DEFINER functions
    FOR f IN 
        SELECT p.proname, n.nspname 
        FROM pg_proc p 
        JOIN pg_namespace n ON p.pronamespace = n.oid 
        WHERE n.nspname = 'public' 
          AND p.prosecdef = true 
          AND NOT 'search_path=""' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
    LOOP
        -- Wait, functions can have different signatures, we should use pg_get_function_identity_arguments to be safe
        EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = ''''', 
            f.nspname, 
            f.proname, 
            pg_get_function_identity_arguments(p.oid)
        );
    END LOOP;

    -- 2. Revoke EXECUTE from PUBLIC, anon, and authenticated on all SECURITY DEFINER functions
    FOR f IN 
        SELECT p.proname, n.nspname, p.oid
        FROM pg_proc p 
        JOIN pg_namespace n ON p.pronamespace = n.oid 
        WHERE n.nspname = 'public' 
          AND p.prosecdef = true
    LOOP
        -- Revoke from PUBLIC (default grant)
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC', 
            f.nspname, f.proname, pg_get_function_identity_arguments(f.oid)
        );
        
        -- Explicitly revoke from anon and authenticated just in case
        BEGIN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM anon', 
                f.nspname, f.proname, pg_get_function_identity_arguments(f.oid)
            );
        EXCEPTION WHEN OTHERS THEN NULL; END;
        
        BEGIN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM authenticated', 
                f.nspname, f.proname, pg_get_function_identity_arguments(f.oid)
            );
        EXCEPTION WHEN OTHERS THEN NULL; END;

        -- Ensure service_role can still execute
        BEGIN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', 
                f.nspname, f.proname, pg_get_function_identity_arguments(f.oid)
            );
        EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
END;
$$;
