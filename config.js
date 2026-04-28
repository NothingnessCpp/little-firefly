const config = {
    petWidth: 150,
    petHeight: 150,
    windowWidth: 550,
    windowHeight: 300,
    affection: 50,      // 初始好感度
    maxAffection: 999,  // 最大好感度
    affectionEvalN: 5,  // 好感度评分参考的最近N轮对话
    wanderSpeed: 10,          // 闲逛每帧移动像素数
    wanderPauseMin: 2000,    // 到达目标后最短停留时间(ms)
    wanderPauseMax: 2000,    // 到达目标后最长停留时间(ms)
    wanderDuration: 300000,  // 闲逛自动停止时长(ms)，0 表示不自动停止
    wanderBobAmplitude: 10,   // 上下弹跳幅度(px)
    wanderSwayAmplitude: 1,  // 左右摇摆幅度(px)
    wanderBobFreq: 0.5,     // 抖动频率（值越大越快）
};

module.exports = config;