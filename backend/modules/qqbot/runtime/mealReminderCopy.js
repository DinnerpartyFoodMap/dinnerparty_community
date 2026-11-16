// Texts of the daily meal reminders (mealReminder.js). One line per day, taken in turn,
// so the same line comes back only after the whole list. Edit freely; keep the times out
// of the text, since QQ_BOT_MEAL_REMINDER_TIMES can move them.
const MEAL_COPY = {
    breakfast: [
        '早。幽幽子大人已经吃完第二轮了，你的早饭呢？',
        '八点几了，饮茶先呢'
    ],
    lunch: [
        '中午了，手头的事先放一放，去吃饭吧。',
        '十一点几了，饮茶先呢'
    ],
    dinner: [
        '傍晚了，晚饭有着落了吗？',
        '五点几了，饮茶先呢'
    ]
};

// Added in groups where the bot answers commands.
const RANDOM_HINT = '不知道吃什么？发 !随机 让我帮你挑一家。';

module.exports = { MEAL_COPY, RANDOM_HINT };
