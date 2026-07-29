"""forms-engine module: schema-driven validation. See agent-guide."""

_TYPES = {"str": str, "int": int, "float": (int, float), "bool": bool}


def validate(schema, payload):
    errors, cleaned = [], {}
    for field in payload:
        if field not in schema:
            errors.append(f"unknown field '{field}'")
    for field, rules in schema.items():
        value = payload.get(field)
        if value is None or value == "":
            if rules.get("required"):
                errors.append(f"'{field}' is required")
            continue
        expected = _TYPES.get(rules.get("type", "str"), str)
        if not isinstance(value, expected) or isinstance(value, bool) and rules.get("type") != "bool":
            errors.append(f"'{field}' must be {rules.get('type', 'str')}")
            continue
        if rules.get("choices") and value not in rules["choices"]:
            errors.append(f"'{field}' must be one of {rules['choices']}")
            continue
        if rules.get("max_len") and isinstance(value, str) and len(value) > rules["max_len"]:
            errors.append(f"'{field}' exceeds {rules['max_len']} chars")
            continue
        cleaned[field] = value
    return {"ok": not errors, "errors": errors, "cleaned": cleaned}
