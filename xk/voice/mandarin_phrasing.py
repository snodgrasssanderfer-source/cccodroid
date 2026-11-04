"""念之前改写文字（主人电脑上的 Codex 调音时加的，11-04 合进来）。
questions：17 字以上、逗号两边各 7 字以上的问句，在最靠中间的逗号后换行，让 GPT-SoVITS 把两半分开生成——
主人觉得小克长问句的情绪对、但节奏怪，分开后衔接和完整度好些。字和问号都不动。"""
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
