import { setSilent } from '../src/core/logger';

// 单元测试期间静默 CLI 进度输出，保持测试报告干净（断言不看 stdout）。
setSilent(true);
