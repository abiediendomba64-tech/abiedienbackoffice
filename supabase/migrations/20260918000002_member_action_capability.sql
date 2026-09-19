-- Canonical member management capability used by backoffice-api-v3.
INSERT INTO public.backoffice_capabilities (code, description, category)
VALUES ('member.manage', 'Approve, suspend, and manage member access state', 'member')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.backoffice_role_capabilities (role, capability_id, capability_code)
SELECT r.role, cap.id, cap.code
FROM (VALUES ('admin'::varchar), ('super_admin'::varchar), ('root'::varchar)) AS r(role)
CROSS JOIN LATERAL (
  SELECT id, code FROM public.backoffice_capabilities
  WHERE code = 'member.manage'
  LIMIT 1
) AS cap
ON CONFLICT (role, capability_code) DO UPDATE SET capability_id = EXCLUDED.capability_id;
