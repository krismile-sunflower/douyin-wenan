/**
 * 阿里云百炼语音识别模块
 * 使用 DashScope paraformer-v2 模型进行视频文案提取
 *
 * 参考: https://github.com/yzfly/douyin-mcp-server
 * 直接用视频 URL 调用百炼 API，不需要下载视频到本地
 */

import axios from 'axios';

export interface TranscriptionResult {
  taskId: string;
  text: string;
  status: string;
}

export interface DashScopeConfig {
  apiKey: string;
  model?: string;
}

const DEFAULT_MODEL = 'paraformer-v2';
const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';

/**
 * 阿里云百炼语音识别
 * 基于 paraformer-v2 模型
 */
export class DashScopeTranscriber {
  private apiKey: string;
  private model: string;

  constructor(config: DashScopeConfig) {
    if (!config.apiKey) {
      throw new Error('缺少 DASHSCOPE_API_KEY，请在环境变量中配置');
    }
    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODEL;
  }

  /**
   * 执行完整的转录流程: 提交任务 → 轮询结果 → 返回文本
   * 参考 douyin-mcp-server 的 extract_text_from_video_url 方法
   */
  async transcribe(videoUrl: string): Promise<TranscriptionResult> {
    // 步骤 1: 提交异步转录任务
    const taskId = await this.submitTask(videoUrl);

    // 步骤 2: 轮询等待转录完成
    const result = await this.pollResult(taskId);

    return result;
  }

  /**
   * 提交异步转录任务
   */
  private async submitTask(videoUrl: string): Promise<string> {
    const requestBody = {
      model: this.model,
      input: {
        file_urls: [videoUrl],
      },
      parameters: {
        format: 'json',
        channel_id: [0],
        language_hints: ['zh', 'en'],
      },
    };

    const response = await axios.post(
      DASHSCOPE_API_URL,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable', // 必须, 否则无法提交任务
        },
        timeout: 30000,
      }
    );

    const data = response.data as Record<string, unknown>;

    // 检查响应状态
    if (data.output && (data.output as Record<string, unknown>).task_id) {
      return (data.output as Record<string, unknown>).task_id as string;
    }

    // 错误处理 — 打印完整响应方便排查
    const statusCode = (data.code as string) || (data.status_code as number);
    const message = (data.message as string) || JSON.stringify(data);
    throw new Error(`提交转录任务失败 [${statusCode}]: ${message}`);
  }

  /**
   * 轮询获取转录结果
   */
  private async pollResult(
    taskId: string,
    maxRetries = 60,
    intervalMs = 3000
  ): Promise<TranscriptionResult> {
    const taskUrl = `${DASHSCOPE_TASK_URL}/${taskId}`;

    for (let i = 0; i < maxRetries; i++) {
      const response = await axios.post(taskUrl, null, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      const data = response.data as Record<string, unknown>;
      const output = data.output as Record<string, unknown> | undefined;
      const taskStatus = output?.task_status as string | undefined;

      if (!taskStatus) {
        throw new Error(`轮询结果异常: ${JSON.stringify(data)}`);
      }

      // 处理中
      if (taskStatus === 'PENDING' || taskStatus === 'RUNNING') {
        await this.sleep(intervalMs);
        continue;
      }

      // 成功
      if (taskStatus === 'SUCCEEDED') {
        return this.parseResult(taskId, output);
      }

      // 失败
      const code = (output?.code as string) || 'UNKNOWN';
      const errorMsg = (output?.message as string) || '未知错误';
      throw new Error(`转录失败 [${code}]: ${errorMsg}`);
    }

    throw new Error('转录超时，请稍后重试');
  }

  /**
   * 解析转录结果
   */
  private async parseResult(taskId: string, output: Record<string, unknown> | undefined): Promise<TranscriptionResult> {
    if (!output) {
      throw new Error('轮询结果 output 为空');
    }

    const results = output.results as Array<Record<string, unknown>> | undefined;

    if (!results || results.length === 0) {
      return {
        taskId,
        text: '未识别到文本内容',
        status: 'SUCCEEDED',
      };
    }

    const firstResult = results[0];

    // 检查子任务状态
    const subtaskStatus = firstResult.subtask_status as string | undefined;
    if (subtaskStatus === 'FAILED') {
      const code = firstResult.code as string || 'UNKNOWN';
      const message = firstResult.message as string || '子任务失败';
      throw new Error(`转录子任务失败 [${code}]: ${message}`);
    }

    const transcriptionUrl = firstResult.transcription_url as string | undefined;

    if (!transcriptionUrl) {
      throw new Error('转录结果中缺少 transcription_url');
    }

    // 下载转录结果 JSON
    const transcriptionResponse = await axios.get(transcriptionUrl, {
      timeout: 15000,
    });

    const transcriptionData = transcriptionResponse.data as Record<string, unknown>;
    const text = this.extractText(transcriptionData);

    return {
      taskId,
      text,
      status: 'SUCCEEDED',
    };
  }

  /**
   * 从转录数据中提取文本
   */
  private extractText(data: Record<string, unknown>): string {
    // 尝试 transcripts 字段 (百炼 API 标准格式)
    const transcripts = data.transcripts as Array<Record<string, unknown>> | undefined;
    if (transcripts && transcripts.length > 0) {
      const text = transcripts[0].text as string;
      if (text) return text;
    }

    // 尝试 text 字段
    if (typeof data.text === 'string' && data.text.length > 0) {
      return data.text;
    }

    // 尝试 sentences 字段
    const sentences = data.sentences as Array<Record<string, unknown>> | undefined;
    if (sentences && sentences.length > 0) {
      return sentences
        .map((s) => (s.text as string) || '')
        .join('');
    }

    return JSON.stringify(data);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
