// COPY of student-dashboard/src/lib/dailyInspiration.js so the daily push
// matches what the app shows that day. Edit both files together.
// RCFMOUAULIBRARYreact/student-dashboard/src/lib/dailyInspiration.js
// Verse of the day (KJV, public domain) and a daily study tip. Everyone
// sees the same one on the same Lagos day, and it changes at midnight.

const VERSES = [
  { ref: 'Proverbs 3:5-6', text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.' },
  { ref: 'Philippians 4:13', text: 'I can do all things through Christ which strengtheneth me.' },
  { ref: 'Jeremiah 29:11', text: 'For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.' },
  { ref: 'James 1:5', text: 'If any of you lack wisdom, let him ask of God, that giveth to all men liberally, and upbraideth not; and it shall be given him.' },
  { ref: 'Isaiah 40:31', text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.' },
  { ref: 'Joshua 1:9', text: 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.' },
  { ref: 'Proverbs 16:3', text: 'Commit thy works unto the LORD, and thy thoughts shall be established.' },
  { ref: 'Colossians 3:23', text: 'And whatsoever ye do, do it heartily, as to the Lord, and not unto men.' },
  { ref: 'Psalm 119:105', text: 'Thy word is a lamp unto my feet, and a light unto my path.' },
  { ref: 'Matthew 6:33', text: 'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.' },
  { ref: '2 Timothy 2:15', text: 'Study to shew thyself approved unto God, a workman that needeth not to be ashamed, rightly dividing the word of truth.' },
  { ref: 'Proverbs 18:15', text: 'The heart of the prudent getteth knowledge; and the ear of the wise seeketh knowledge.' },
  { ref: 'Philippians 4:6', text: 'Be careful for nothing; but in every thing by prayer and supplication with thanksgiving let your requests be made known unto God.' },
  { ref: 'Romans 8:28', text: 'And we know that all things work together for good to them that love God, to them who are the called according to his purpose.' },
  { ref: 'Psalm 32:8', text: 'I will instruct thee and teach thee in the way which thou shalt go: I will guide thee with mine eye.' },
  { ref: 'Galatians 6:9', text: 'And let us not be weary in well doing: for in due season we shall reap, if we faint not.' },
  { ref: 'Proverbs 4:7', text: 'Wisdom is the principal thing; therefore get wisdom: and with all thy getting get understanding.' },
  { ref: 'Isaiah 41:10', text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God: I will strengthen thee; yea, I will help thee.' },
  { ref: '1 Peter 5:7', text: 'Casting all your care upon him; for he careth for you.' },
  { ref: 'Psalm 46:1', text: 'God is our refuge and strength, a very present help in trouble.' },
  { ref: 'Daniel 1:17', text: 'As for these four children, God gave them knowledge and skill in all learning and wisdom.' },
  { ref: 'Ecclesiastes 9:10', text: 'Whatsoever thy hand findeth to do, do it with thy might.' },
  { ref: 'Matthew 11:28', text: 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.' },
  { ref: 'Psalm 37:5', text: 'Commit thy way unto the LORD; trust also in him; and he shall bring it to pass.' },
  { ref: 'Proverbs 2:6', text: 'For the LORD giveth wisdom: out of his mouth cometh knowledge and understanding.' },
  { ref: 'Hebrews 11:1', text: 'Now faith is the substance of things hoped for, the evidence of things not seen.' },
  { ref: '2 Corinthians 12:9', text: 'And he said unto me, My grace is sufficient for thee: for my strength is made perfect in weakness.' },
  { ref: 'Psalm 23:1', text: 'The LORD is my shepherd; I shall not want.' },
  { ref: 'Lamentations 3:22-23', text: 'It is of the LORD\'s mercies that we are not consumed, because his compassions fail not. They are new every morning: great is thy faithfulness.' },
  { ref: 'Deuteronomy 31:6', text: 'Be strong and of a good courage, fear not, nor be afraid of them: for the LORD thy God, he it is that doth go with thee; he will not fail thee, nor forsake thee.' },
  { ref: 'John 14:27', text: 'Peace I leave with you, my peace I give unto you: not as the world giveth, give I unto you. Let not your heart be troubled, neither let it be afraid.' },
]

const TIPS = [
  { icon: 'timer', text: 'Try the Pomodoro method: 25 minutes of focused reading, then a 5-minute break. After 4 rounds, take a longer break.' },
  { icon: 'quiz', text: 'Test yourself instead of re-reading. Close the book and write down everything you remember, then check what you missed.' },
  { icon: 'event_repeat', text: 'Spaced repetition beats cramming. Review today\'s notes tomorrow, then in 3 days, then in a week.' },
  { icon: 'record_voice_over', text: 'Teach it to someone else (or to your mirror). If you can explain it simply, you truly understand it.' },
  { icon: 'phone_disabled', text: 'Put your phone in another room while studying. Even a silent phone on the table steals focus.' },
  { icon: 'bedtime', text: 'Sleep is study time too. Your brain stores what you learned while you sleep, so don\'t trade sleep for one more hour of reading.' },
  { icon: 'history_edu', text: 'Past questions show you how examiners think. Solve at least one past paper per course before the exam.' },
  { icon: 'edit_note', text: 'Write notes in your own words. Copying the textbook word for word feels productive but sticks less.' },
  { icon: 'shuffle', text: 'Mix topics in one session (interleaving). Switching between related topics helps you tell them apart in exams.' },
  { icon: 'water_drop', text: 'Drink water and take short walks. A tired, dehydrated brain reads the same paragraph three times.' },
  { icon: 'psychology', text: 'Start with the hardest topic while your mind is fresh. Save easy revision for when you\'re tired.' },
  { icon: 'account_tree', text: 'Draw a mind map of a chapter: main idea in the middle, branches for sub-topics. It shows how everything connects.' },
  { icon: 'groups', text: 'Study groups work best with a plan: each person prepares one topic and teaches it to the others.' },
  { icon: 'calendar_month', text: 'Plan your week on Sunday: list each course, the topics to cover, and when. A plan you can see is a plan you follow.' },
  { icon: 'help', text: 'Turn headings into questions before you read ("What causes soil erosion?"). Reading to answer a question keeps you focused.' },
  { icon: 'emoji_events', text: 'Reward yourself after a study goal: a snack, a show, a walk. Small wins keep the streak going.' },
  { icon: 'light_mode', text: 'Study at the same time and place each day. Your brain gets into "study mode" faster with a routine.' },
  { icon: 'summarize', text: 'After each chapter, write a 3-line summary. If you can\'t, you\'re not ready to move on yet.' },
  { icon: 'headphones', text: 'Use dead time: listen to an audiobook or lecture recording while walking to class.' },
  { icon: 'self_improvement', text: 'Feeling overwhelmed? Breathe in for 4, hold for 4, out for 4. Then do just the first small task.' },
  { icon: 'fact_check', text: 'Check the course outline before exams. Study what will be examined first, then extras.' },
  { icon: 'local_library', text: 'Read the summary and conclusion of a chapter first. Knowing where it\'s going makes the middle easier.' },
  { icon: 'draw', text: 'Handwriting notes helps memory more than typing, because you have to choose what matters.' },
  { icon: 'auto_stories', text: 'Read a little every day rather than a lot once a week. 20 minutes daily adds up to over 2 hours a week.' },
  { icon: 'chat', text: 'Stuck on something? Ask a classmate or tag Bro Paul in the group. Asking early saves hours.' },
  { icon: 'checklist', text: 'Break big tasks into tiny steps: "read pages 10 to 15" is easier to start than "study chemistry".' },
  { icon: 'volunteer_activism', text: 'Share your notes and past questions on the library. Helping others revise is one of the best ways to revise yourself.' },
  { icon: 'nutrition', text: 'Eat breakfast before morning lectures and exams. Your brain runs on glucose.' },
  { icon: 'do_not_disturb_on', text: 'Turn off notifications for one hour of deep work. You\'ll get more done than in a whole distracted afternoon.' },
  { icon: 'flag', text: 'Set a weekly reading goal you can actually hit. Hitting a small goal beats missing a big one.' },
]

function lagosDayNumber() {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000)
}

export function verseOfTheDay() {
  return VERSES[lagosDayNumber() % VERSES.length]
}

export function tipOfTheDay() {
  // Offset so the tip and verse lists don't move in lockstep.
  return TIPS[(lagosDayNumber() + 7) % TIPS.length]
}
