import re

_Q_PREFIX = re.compile(r"^\s*(?:Q|Question)\s*[:.]\s*", re.IGNORECASE)
_A_PREFIX = re.compile(r"^\s*(?:A|Answer)\s*[:.]\s*", re.IGNORECASE)


def parse_qa_pairs(text: str) -> list[tuple[str, str]]:
    """Parses 'Q: ... / A: ...' (or 'Question:'/'Answer:') pairs from uploaded text.
    Blank lines and pair separation are both optional - a new 'Q:' line after an 'A:'
    line starts the next pair either way."""
    pairs: list[tuple[str, str]] = []
    current_q: list[str] = []
    current_a: list[str] = []
    mode: str | None = None

    def flush():
        q = " ".join(current_q).strip()
        a = " ".join(current_a).strip()
        if q and a:
            pairs.append((q, a))
        current_q.clear()
        current_a.clear()

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        q_match = _Q_PREFIX.match(line)
        a_match = _A_PREFIX.match(line)
        if q_match:
            if mode == "a":
                flush()
            mode = "q"
            current_q.append(line[q_match.end():].strip())
        elif a_match:
            mode = "a"
            current_a.append(line[a_match.end():].strip())
        elif mode == "q":
            current_q.append(line)
        elif mode == "a":
            current_a.append(line)

    flush()
    return pairs
