// 底栏小伙伴的状态机：根据时间、操作、投喂和地图控件决定现在做什么，交给 CompanionActor 移动、Live2D 场景播动作。
//
// 状态与触发（数值见 companionBehavior.js）：
// - standby 发呆：刚落地、走完一段后先发呆几秒（饿了播 Hungry、吃饱时一半播 Full，否则 Standby）。
// - wandering 游走：发呆后在地面范围内走一段（不走到右侧按钮底下），朝走的方向转头。
// - climb 攀爬 → 站在按钮顶上：发呆后按概率去爬右侧按钮组（饿着不爬，两次至少隔 90 秒），在顶上待一会儿。
// - jumpoff 跳下：在按钮上待够时间后蹲下、往左跳回地面。
// - drop 掉落：页面首次出现时从上方落下；飞起后收起更多功能 / 搜索时落回；站着的按钮没了（隐藏、搜索）时掉下。
// - sleep 睡觉：一段时间没有操作（白天 150 秒、饿着 90 秒、夜里 30 秒）就地睡下，有操作时醒来（Wake）。
// - hungry / full：距上次投喂 48 小时以上为饿（走得慢、不爬），投喂后 3 小时内为饱（走得快、更爱爬）；
//   新的投喂在 3 小时内回到地图时补一次庆祝（点头、爱心、蹦两下、晃着笑）。
// - 飞：上拉更多功能或出现搜索结果时（lift > 0）打断一切飞上去悬停，睡着的先醒。
// 减弱动态效果时不走不爬不睡，只在需要时换位置。
import { CLIMB, celebrationDue, climbRoute, companionNeeds, decideNext, isNight, jumpLanding, sleepDelay, standbyMotion, walkBand, walkSpeed } from './companionBehavior.js';
import { MOTION, ONE_SHOT_SECONDS } from './sharedMotions.js';

/** 同一次页面里记住位置，卡片关掉重新出现时不从头开始；首次出现从上面掉下来 */
const memory = { x: null, entered: false };

/** 首次出现时从多高落下 */
const ENTRANCE_HEIGHT = 90;
const CELEBRATED_KEY = 'foodmap.companion.celebrated';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readCelebrated(storage) {
    try { return Number(storage?.getItem(CELEBRATED_KEY)) || 0; } catch { return 0; }
}

function saveCelebrated(storage, value) {
    try { storage?.setItem(CELEBRATED_KEY, String(value)); } catch { /* 隐私模式等：只是可能重复庆祝 */ }
}

export class CompanionDirector {
    /**
     * actor：CompanionActor；measure()：{ left, ground, width, column }（视口坐标，column 为右侧按钮组外框或 null）；
     * clock / random / storage / timers（{ set(fn, ms), clear(id) }）可在测试中替换。
     */
    constructor({ actor, measure, clock = () => Date.now(), random = Math.random, storage = globalThis.localStorage,
        timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) } }) {
        this.actor = actor;
        this.measure = measure;
        this.clock = clock;
        this.random = random;
        this.storage = storage;
        this.timers = timers;
        this.scene = null;
        this.token = 0;
        this.waits = new Set();
        this.inputs = { lift: 0, reduced: false, fedAt: null, adoptedAt: null };
        this.state = { surface: 'ground', aloft: false, sleeping: false, last: null, lastClimbAt: -Infinity, perchUntil: 0 };
        this.pose = { loop: MOTION.standby, facing: 0, mood: null };
        this.lastActivity = this.clock();
        this.celebrated = readCelebrated(storage);
        this.phase = 'idle';
        this.visible = true;
        this.destroyed = false;
    }

    // ---------- 外部输入 ----------

    /** Live2D 场景就绪（或换角色）：补上当前的循环动作、朝向与姿态 */
    setScene(scene) {
        this.scene = scene;
        if (!scene) return;
        scene.loop(this.pose.loop);
        scene.face(this.pose.facing);
        scene.setMood(this.pose.mood);
    }

    /** lift 飞多高；reduced 减弱动态效果；fedAt / adoptedAt 上次投喂与领养时间 */
    update({ lift = 0, reduced = false, fedAt = null, adoptedAt = null }) {
        const previous = this.inputs;
        this.inputs = { lift: Math.max(0, Math.round(lift)), reduced, fedAt, adoptedAt };
        if (this.inputs.lift !== previous.lift || reduced !== previous.reduced) {
            if (this.inputs.lift > 0 || previous.lift > 0) this.noteActivity(false);
            return this.restart();
        }
        if (fedAt !== previous.fedAt && this._celebrationDue() && !this.state.aloft) this.restart();
    }

    /** 用户有操作（触摸、拖地图、按键）：重置睡意，睡着的醒来 */
    noteActivity(wake = true) {
        this.lastActivity = this.clock();
        if (wake && this.state.sleeping) this.restart();
    }

    /** 地图尺寸、地面或按钮位置变了：在按钮上、正在爬的重新判断（按钮没了就掉下来） */
    geometryChanged() {
        if (this.state.surface === 'column' || this.phase === 'climb') this.restart();
    }

    /** 页面切到后台时停下，回来时算作一次操作 */
    setVisible(visible) {
        if (visible === this.visible) return;
        this.visible = visible;
        if (!visible) {
            this._interrupt();
            return;
        }
        this.lastActivity = this.clock();
        this.restart();
    }

    start() {
        this.restart();
    }

    restart() {
        if (this.destroyed) return;
        this._interrupt();
        if (!this.visible) return;
        const token = this.token;
        this._run(token).catch((error) => console.warn('companion behaviour failed', error));
    }

    destroy() {
        this.destroyed = true;
        this._interrupt();
    }

    // ---------- 内部 ----------

    _interrupt() {
        this.token += 1;
        for (const resolve of this.waits) resolve(false);
        this.waits.clear();
        this.actor.stop();
    }

    _live(token) {
        return token === this.token && !this.destroyed;
    }

    /** 等 ms 毫秒；被打断时返回 false。Infinity 一直等到被打断 */
    _wait(token, ms) {
        if (!this._live(token)) return Promise.resolve(false);
        return new Promise((resolve) => {
            let timer = null;
            const done = (value) => {
                if (timer !== null) this.timers.clear(timer);
                this.waits.delete(done);
                resolve(value);
            };
            this.waits.add(done);
            if (Number.isFinite(ms)) timer = this.timers.set(() => done(this._live(token)), Math.max(0, ms));
        });
    }

    _loop(group) {
        this.pose.loop = group;
        this.scene?.loop(group);
    }

    _play(group) {
        this.scene?.play(group);
    }

    _face(direction) {
        this.pose.facing = direction;
        this.scene?.face(direction);
    }

    _mood(name) {
        this.pose.mood = name;
        this.scene?.setMood(name);
    }

    _needs(now = this.clock()) {
        return companionNeeds({ fedAt: this.inputs.fedAt, adoptedAt: this.inputs.adoptedAt, now });
    }

    _celebrationDue() {
        const now = this.clock();
        return celebrationDue({ needs: this._needs(now), celebrated: this.celebrated, now });
    }

    _sleepIn(needs) {
        const now = this.clock();
        return this.lastActivity + sleepDelay({ hungry: needs.hungry, night: isNight(new Date(now)) }) - now;
    }

    _geometry() {
        const geometry = this.measure();
        return { geometry, band: walkBand(geometry), route: climbRoute(geometry) };
    }

    /** 不在所站的面上（爬到一半被打断、按钮没了或挪了位置） */
    _offSurface(y, route) {
        if (this.state.surface === 'column') return !route || Math.abs(y - route.topY) > 4;
        return y > 1;
    }

    _home(band) {
        return clamp(memory.x ?? Math.round(band.min + (band.max - band.min) * 0.3), band.min, band.max);
    }

    async _run(token) {
        const live = () => this._live(token);
        const entering = !memory.entered;
        memory.entered = true;
        const { band, route } = this._geometry();
        const { x, y } = this.actor.position();
        if (this.inputs.reduced) return this._still(token, band);
        if (this.state.sleeping) {
            await this._wake(token, this.inputs.lift > 0);
            if (!live()) return;
        }
        if (this.inputs.lift > 0) return this._hover(token, band, entering);
        if (entering) {
            const start = this._home(band);
            this.actor.place(start, ENTRANCE_HEIGHT);
            await this._drop(token, start);
            if (!live()) return;
        } else if (this.state.aloft || this._offSurface(y, route)) {
            await this._drop(token, clamp(x, band.min, band.max));
            if (!live()) return;
        }
        for (;;) {
            if (!live()) return;
            const needs = this._needs();
            if (this._celebrationDue()) {
                await this._celebrate(token);
                continue;
            }
            if (this._sleepIn(needs) <= 0) return this._sleep(token);
            const { band: area, route } = this._geometry();
            if (this.state.surface === 'column') {
                await this._perch(token, needs, area, route);
                continue;
            }
            const position = this.actor.position();
            const next = decideNext({ last: this.state.last, x: position.x, band: area, route, needs, now: this.clock(),
                lastClimbAt: this.state.lastClimbAt, random: this.random });
            this.state.last = next.type;
            if (next.type === 'standby') {
                this.phase = 'standby';
                this._loop(next.motion);
                await this._wait(token, Math.min(next.ms, Math.max(0, this._sleepIn(needs))));
            } else if (next.type === 'wander') {
                await this._walk(token, next.to, needs);
            } else if (next.type === 'climb') {
                await this._climb(token, route, needs);
            }
        }
    }

    async _walk(token, to, needs) {
        const { x } = this.actor.position();
        this.phase = 'wander';
        if (Math.abs(to - x) >= 1) this._face(Math.sign(to - x));
        this._loop(MOTION.wander);
        const arrived = await this.actor.walk(to, walkSpeed(needs));
        if (arrived && this._live(token)) memory.x = to;
        return arrived && this._live(token);
    }

    async _climb(token, route, needs) {
        if (!(await this._walk(token, route.footX, needs))) return;
        this.phase = 'climb';
        this._face(1);
        this._loop(MOTION.climb);
        if (!(await this.actor.climb(route.topY - CLIMB.reach, { step: CLIMB.step, stepMs: CLIMB.stepMs })) || !this._live(token)) return;
        // 翻上去，站到按钮组中间
        if (!(await this.actor.arc(route.perchX, route.topY, { peak: 10, upMs: 200, downMs: 180, surface: route.topY })) || !this._live(token)) return;
        this.actor.squash();
        this._face(0);
        this._loop(standbyMotion(needs, this.random));
        const now = this.clock();
        Object.assign(this.state, { surface: 'column', last: 'climb', lastClimbAt: now,
            perchUntil: now + CLIMB.perchMs[0] + (CLIMB.perchMs[1] - CLIMB.perchMs[0]) * this.random() });
        this.phase = 'perch';
    }

    async _perch(token, needs, band, route) {
        if (!route) {
            const { x } = this.actor.position();
            await this._drop(token, clamp(x, band.min, band.max));
            return;
        }
        const left = this.state.perchUntil - this.clock();
        if (left > 0) {
            this.phase = 'perch';
            await this._wait(token, Math.min(left, Math.max(0, this._sleepIn(needs))));
            return;
        }
        // 跳下：蹲、往左跳出去、着地
        this.phase = 'jumpoff';
        const landX = jumpLanding(route, band, this.random);
        this._face(-1);
        this._play(MOTION.jumpOff);
        if (!(await this.actor.crouch(220)) || !this._live(token)) return;
        const fall = Math.round(260 + Math.sqrt(route.topY + 22) * 18);
        if (!(await this.actor.arc(landX, 0, { peak: 22, upMs: 230, downMs: fall, surface: 0 })) || !this._live(token)) return;
        this._land(token);
        Object.assign(this.state, { surface: 'ground', last: 'jumpoff' });
        memory.x = landX;
        await this._wait(token, ONE_SHOT_SECONDS.Land * 1000);
    }

    /** 着地：Land 动作 + 压扁 */
    _land() {
        this._play(MOTION.land);
        this.actor.squash();
    }

    /** 掉到地面 x 处（越落越快），着地后站稳 */
    async _drop(token, x) {
        this.phase = 'drop';
        this._mood(null);
        this._play(MOTION.drop);
        const { touchdown, settled } = this.actor.fly(x, 0, { reduced: this.inputs.reduced });
        if (!(await touchdown) || !this._live(token)) return;
        this._play(MOTION.land);
        Object.assign(this.state, { aloft: false, surface: 'ground', last: 'drop' });
        memory.x = x;
        await settled;
        // 让 Land 做完再换动作（压扁弹回 300 毫秒已经过去）
        await this._wait(token, ONE_SHOT_SECONDS.Land * 1000 - 300);
    }

    /** 飞上去悬停在 lift 高度（x 收进地面范围，避开右侧按钮），等到 lift 变化。刚出现时直接停在空中 */
    async _hover(token, band, entering = false) {
        this.phase = 'aloft';
        const { x } = this.actor.position();
        const target = entering ? this._home(band) : clamp(x, band.min, band.max);
        Object.assign(this.state, { aloft: true, surface: 'ground' });
        this._mood('aloft');
        this._loop(MOTION.standby);
        if (entering) this.actor.place(target, this.inputs.lift);
        else this.actor.fly(target, this.inputs.lift, { reduced: this.inputs.reduced });
        if (entering) this.actor.hover(!this.inputs.reduced);
        await this._wait(token, Infinity);
    }

    async _sleep(token) {
        this.phase = 'sleep';
        this.state.sleeping = true;
        this._face(0);
        this._loop(MOTION.sleep);
        this.actor.zzz(true);
        await this._wait(token, Infinity);
    }

    /** 醒来：眨眨眼、甩甩头、轻轻一蹦；quick 为马上要飞走，不等动作做完 */
    async _wake(token, quick = false) {
        this.phase = 'wake';
        this.state.sleeping = false;
        this.actor.zzz(false);
        this._loop(MOTION.standby);
        this._play(MOTION.wake);
        if (quick) return;
        this.actor.hop(6, 260);
        await this._wait(token, ONE_SHOT_SECONDS.Wake * 1000);
        this.state.last = 'wake';
    }

    async _celebrate(token) {
        const { fedAt } = this._needs();
        this.celebrated = fedAt;
        saveCelebrated(this.storage, fedAt);
        this.phase = 'full';
        const started = this.clock();
        this._play(MOTION.feed);
        this.actor.heart();
        if (!(await this.actor.hop(14, 360)) || !this._live(token)) return;
        if (!(await this.actor.hop(10, 320)) || !this._live(token)) return;
        // 点头（Feed）做完再换成吃饱的晃动
        if (!(await this._wait(token, ONE_SHOT_SECONDS.Feed * 1000 - (this.clock() - started)))) return;
        this._loop(MOTION.full);
        await this._wait(token, 3500);
        this.state.last = 'full';
    }

    /** 减弱动态效果：停在当前位置或 lift 高度，不走动 */
    async _still(token, band) {
        this.phase = 'still';
        const target = this._home(band);
        this.state.aloft = this.inputs.lift > 0;
        const { settled } = this.actor.fly(target, this.inputs.lift, { reduced: true });
        await settled;
        if (this._live(token) && this._celebrationDue()) {
            const { fedAt } = this._needs();
            this.celebrated = fedAt;
            saveCelebrated(this.storage, fedAt);
            this.actor.heart();
        }
        await this._wait(token, Infinity);
    }
}

/** 测试用：重置同一页面里记住的位置 */
export function resetCompanionMemory() {
    memory.x = null;
    memory.entered = false;
}
