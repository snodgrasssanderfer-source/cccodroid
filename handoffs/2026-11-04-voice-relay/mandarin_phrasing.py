"""Preserve question intonation while giving long two-clause questions separate decoding budgets."""
import re


def spoken_text(text, mode=None):
    if mode != "questions":
        return text
    def divide(match):
        sentence = match.group()
        commas = [m.end() for m in re.finditer(r"[，,]", sentence)]
        eligible = [i for i in commas if len(sentence[:i].strip()) >= 7 and len(sentence[i:].strip()) >= 7]
        if len(sentence) < 17 or not eligible:
            return sentence
        at = min(eligible, key=lambda i: abs(len(sentence) / 2 - i))
        return sentence[:at] + "\n" + sentence[at:]
    return re.sub(r"[^。！？!?\n]+[？?]", divide, text)
