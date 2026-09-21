"""Training and test phrases for the spoken "Are you feeling okay?" check.

Labels
  ok       the driver says they are fine        ("yes", "I'm good", "no, I'm fine")
  not_ok   the driver is not fine / needs help  ("no", "not really", "I feel dizzy")
  unclear  not an answer                        ("what?", "hold on", radio chatter)

"help"-type answers (911, ambulance, chest pain, can't breathe) are not_ok; the
app also flags them as URGENT with a keyword rule on top of the model
(lib/voice/intent.ts), so they escalate even if the model hesitated.

The question is always "Are you feeling okay?", which is what makes
"no, I'm fine" an OK answer and "not bad" an OK answer.

Phrases are written the way a speech recogniser transcribes them (lowercase,
little punctuation, filler words, "yeah"/"yep"/"ya"). English and Spanish,
because the prototype is tested in Miami. The TEST set is written separately
and is never used for training (tools/intent/train.py reports on it).
"""
import itertools
import random

# ------------------------------------------------------------------ building blocks
YES = ["yes", "yeah", "yep", "yup", "ya", "yah", "yea", "yes sir", "yes ma'am", "sure", "of course",
       "definitely", "absolutely", "affirmative", "uh huh", "mm hmm", "mhm", "correct", "right", "totally",
       "yes yes", "yeah yeah", "for sure", "you bet", "certainly", "indeed", "roger", "yessir"]
FINE = ["i'm fine", "i'm okay", "i'm ok", "i'm good", "i'm alright", "i'm all right", "i am fine", "i am okay",
        "i am good", "all good", "all good here", "doing fine", "doing good", "doing great", "doing okay",
        "i'm great", "i feel fine", "i feel good", "i feel okay", "i feel great", "feeling fine", "feeling good",
        "feeling okay", "feeling great", "never better", "i'm doing well", "i'm well", "everything's fine",
        "everything is fine", "everything's okay", "everything is okay", "it's fine", "it's okay", "all fine",
        "totally fine", "perfectly fine", "just fine", "i'm cool", "i'm chill", "no problem", "no problems",
        "no worries", "not bad", "i'm not bad", "not too bad", "not bad actually", "not bad thanks", "can't complain", "pretty good", "good", "fine", "okay", "ok",
        "alright", "all right", "great", "i'm straight", "i'm totally fine", "i'm perfectly fine",
        "i'm fine thanks", "fine thank you", "good thanks", "i'm okay thanks", "false alarm", "that's a false alarm",
        "i'm just driving", "i was just stressed", "just a little stressed but fine", "i'm fine just traffic",
        "i'm okay just tired", "i'm fine it's just the road", "i'm fine don't worry"]
NO = ["no", "nope", "nah", "no no", "negative", "not really", "not at all", "no i'm not", "no i am not",
      "i'm not", "not good", "not great", "not so good", "not well", "no not really", "not okay", "not ok",
      "not fine", "not really no", "no way", "nah man", "no sir", "no ma'am", "uh uh", "hell no", "i don't think so",
      "i don't know i don't feel right"]
UNWELL = ["i'm not okay", "i'm not ok", "i'm not fine", "i'm not good", "i'm not alright", "i'm not all right",
          "i don't feel good", "i don't feel well", "i don't feel okay", "i don't feel right", "i feel sick",
          "i feel bad", "i feel terrible", "i feel awful", "i feel weird", "i feel strange", "i feel off",
          "something's wrong", "something is wrong", "something's not right", "i'm sick", "i'm dizzy", "i feel dizzy",
          "i'm lightheaded", "i feel lightheaded", "i feel faint", "i'm going to pass out", "i think i'm going to faint",
          "i'm nauseous", "i feel nauseous", "i'm going to throw up", "my heart is racing", "my heart's pounding",
          "my heart is beating fast", "heart's racing", "i have chest pain", "my chest hurts", "chest pain",
          "my arm hurts", "my arm is numb", "i can't feel my arm", "i can't breathe", "hard to breathe",
          "i'm short of breath", "i can't catch my breath", "i can't see well", "my vision is blurry", "blurry vision",
          "i'm having a panic attack", "i'm panicking", "i'm scared", "i'm really tired i can't stay awake",
          "i'm falling asleep", "i'm so sleepy", "i have a headache", "my head hurts really bad",
          "i'm sweating a lot", "i'm shaking", "i feel like i'm dying", "i'm having a heart attack",
          "i think i'm having a stroke", "my face feels numb", "i can't talk right", "i'm confused", "i don't know where i am",
          "i'm hurt", "i'm in pain", "it hurts", "it hurts a lot", "pull over", "i need to pull over",
          "i need to stop", "i need to stop the car"]
HELP = ["help", "help me", "help me please", "i need help", "please help", "somebody help", "call 911",
        "call nine one one", "call an ambulance", "get an ambulance", "call for help", "call my wife",
        "call my husband", "call my mom", "call someone", "emergency", "it's an emergency", "this is an emergency",
        "get help", "send help", "i need a doctor", "take me to the hospital", "hospital", "ambulance", "sos",
        "i need an ambulance", "call the police"]
UNCLEAR = ["what", "what did you say", "huh", "sorry what", "can you repeat that", "repeat that", "say again",
           "come again", "hold on", "wait", "one second", "hang on", "who is this", "what is this", "hello",
           "hey", "i don't know", "maybe", "i guess", "hmm", "um", "uh", "let me think", "turn left here",
           "the light is green", "where are we going", "play some music", "what time is it", "how far is it",
           "okay google", "hey siri", "what are you talking about", "stop talking", "be quiet",
           "the traffic is crazy", "take the next exit", "i'm on the phone", "call you back", "later",
           "what do you mean", "why are you asking", "is this thing on", "testing testing", "blah blah",
           "the weather is nice", "radio", "turn it up", "i'm hungry", "let's get food"]

# Spanish (Miami). Accents are removed by the featuriser, so "si"/"sí" match.
ES_YES = ["sí", "si", "sí sí", "claro", "claro que sí", "por supuesto", "ajá", "sí señor", "sí señora", "dale",
          "correcto", "exacto", "seguro", "sí claro"]
ES_FINE = ["estoy bien", "bien", "todo bien", "muy bien", "me siento bien", "estoy perfecto", "estoy perfecta",
           "tranquilo", "tranquila", "no pasa nada", "estoy bien gracias", "bien gracias", "todo está bien",
           "no te preocupes", "estoy bien no te preocupes", "sin problema", "normal", "estoy normal"]
ES_NO = ["no", "no no", "para nada", "no mucho", "no realmente", "no estoy bien", "no me siento bien", "mal",
         "estoy mal", "me siento mal", "muy mal", "no creo", "nada bien", "no estoy muy bien", "no estoy tan bien",
         "no me siento nada bien", "no me siento muy bien", "no estoy para nada bien", "estoy fatal", "fatal",
         "no me encuentro bien", "no estoy bien para nada", "la verdad no", "no mucho la verdad"]
ES_UNWELL = ["estoy mareado", "estoy mareada", "me siento mareado", "me siento mareada", "me duele el pecho",
             "dolor en el pecho", "no puedo respirar", "me falta el aire", "me voy a desmayar", "me siento débil",
             "tengo náuseas", "me duele la cabeza", "no veo bien", "me duele el brazo", "tengo miedo",
             "me está dando un infarto", "algo está mal", "me siento raro", "me siento rara", "estoy cansado no puedo más",
             "tengo que parar", "necesito parar"]
ES_HELP = ["ayuda", "ayúdame", "necesito ayuda", "llama al 911", "llama al nueve uno uno", "llama a una ambulancia",
           "una ambulancia", "emergencia", "es una emergencia", "llama a mi esposa", "llama a mi esposo",
           "llama a mi mamá", "auxilio", "llévame al hospital", "necesito un médico"]
ES_UNCLEAR = ["qué", "cómo", "qué dijiste", "repite", "espera", "un momento", "no sé", "tal vez", "quizás",
              "hola", "oye", "pon música", "dobla a la izquierda", "no entiendo", "qué es esto"]

FILLERS = ["", "um ", "uh ", "oh ", "well ", "yeah ", "honestly ", "like ", "so "]
ENDS = ["", " thanks", " thank you", " man", " bro", " dude", " sir", " please", " really", " i think", " for real"]


def _mix(heads, tails, joiners=(" ", " ", " ")):
    for h, t in itertools.product(heads, tails):
        yield f"{h}{random.choice(joiners)}{t}".strip()


def training_set(seed: int = 7):
    random.seed(seed)
    rows = []
    ok = YES + FINE + ES_YES + ES_FINE
    ok += list(_mix(YES[:14], FINE[:30]))                                   # "yeah i'm fine"
    ok += [f"no {f}" for f in ["i'm fine", "i'm okay", "i'm good", "i'm alright", "all good", "i'm totally fine",
                               "i'm ok", "everything's fine", "it's fine", "i'm fine don't worry"]]
    ok += [f"no no {f}" for f in ["i'm fine", "i'm okay", "i'm good", "it's okay"]]
    ok += ["i'm fine no need", "no need i'm fine", "nothing's wrong", "nothing is wrong", "nothing wrong",
           "there's nothing wrong", "i don't need help", "i don't need anything", "no help needed",
           "don't call anyone", "don't worry about it", "i'm not sick", "i'm not hurt", "not hurt",
           "i'm not in pain", "no pain", "no i don't need help"]
    ok += list(_mix(ES_YES[:6], ES_FINE[:10]))
    ok += ["estoy bien gracias", "no no estoy bien", "no, estoy bien", "no necesito ayuda", "no me pasa nada",
           "no tengo nada", "nada nada estoy bien"]
    not_ok = NO + UNWELL + HELP + ES_NO + ES_UNWELL + ES_HELP
    not_ok += list(_mix(NO[:12], UNWELL[:40]))                              # "no i feel dizzy"
    not_ok += list(_mix(["yes", "yeah", "please"], HELP))                   # "yes i need help"
    not_ok += list(_mix(ES_NO[:5], ES_UNWELL[:12]))
    not_ok += ["i'm not doing well", "not doing well", "not doing good", "not feeling well", "not feeling good",
               "not feeling great", "not feeling okay", "i'm not feeling well", "i'm not feeling good",
               "i've been better", "could be better", "not really i feel off", "kind of dizzy", "a little dizzy",
               "a bit dizzy", "kinda sick", "i think something's wrong", "i'm not sure i feel weird"]
    unclear = UNCLEAR + ES_UNCLEAR
    unclear += list(_mix(["what", "sorry", "huh", "wait"], ["what did you say", "can you repeat", "say that again", "i didn't hear you"]))

    for label, items in (("ok", ok), ("not_ok", not_ok), ("unclear", unclear)):
        for p in items:
            rows.append((p, label))
            # recogniser-style variations: fillers and trailing words
            for _ in range(2):
                rows.append((f"{random.choice(FILLERS)}{p}{random.choice(ENDS)}".strip(), label))
    random.shuffle(rows)
    return rows


# ------------------------------------------------------------ held-out test set
# Written by hand, phrased differently from the training templates.
TEST = [
    # ok
    ("yeah i'm doing alright", "ok"), ("yep all good", "ok"), ("i'm totally okay thank you", "ok"),
    ("no no i'm good man", "ok"), ("nah i'm fine", "ok"), ("i'm fine why", "ok"), ("sure i'm fine", "ok"),
    ("i'm ok just a bit tired", "ok"), ("yes i feel okay", "ok"), ("mm hmm i'm good", "ok"),
    ("everything's all right", "ok"), ("i'm good bro", "ok"), ("not bad at all", "ok"), ("fine fine", "ok"),
    ("yes everything is okay", "ok"), ("absolutely fine", "ok"), ("i'm fine it was nothing", "ok"),
    ("sí estoy bien", "ok"), ("todo bien gracias", "ok"), ("claro estoy bien", "ok"), ("no, todo bien", "ok"),
    ("yeah yeah i'm okay", "ok"), ("of course i'm okay", "ok"), ("i feel alright", "ok"),
    ("no i don't need anything", "ok"), ("i'm good just hit a bump", "ok"),
    # not ok
    ("no i don't feel so good", "not_ok"), ("not really my chest is tight", "not_ok"),
    ("i feel really dizzy", "not_ok"), ("i think i need help", "not_ok"), ("please call 911", "not_ok"),
    ("i can't breathe well", "not_ok"), ("my heart is racing really fast", "not_ok"), ("nope not okay", "not_ok"),
    ("i'm not feeling so hot", "not_ok"), ("i feel like i'm going to pass out", "not_ok"), ("no i'm dizzy", "not_ok"),
    ("i'm not okay at all", "not_ok"), ("call an ambulance please", "not_ok"), ("i feel sick to my stomach", "not_ok"),
    ("no estoy nada bien", "not_ok"), ("me siento muy mareado", "not_ok"), ("ayúdame por favor", "not_ok"),
    ("llama al 911 ya", "not_ok"), ("my arm feels numb", "not_ok"), ("i need to stop right now", "not_ok"),
    ("not good at all", "not_ok"), ("yes i need an ambulance", "not_ok"), ("nah i feel weird", "not_ok"),
    ("i don't feel right at all", "not_ok"), ("something feels wrong", "not_ok"),
    # unclear
    ("what was that", "unclear"), ("say it again please", "unclear"), ("hold on a sec", "unclear"),
    ("who said that", "unclear"), ("turn right at the light", "unclear"), ("hmm let me see", "unclear"),
    ("sorry i didn't catch that", "unclear"), ("qué dijiste", "unclear"), ("espera un momento", "unclear"),
    ("put on the radio", "unclear"), ("i'm not sure what you mean", "unclear"), ("hello who is this", "unclear"),
]
