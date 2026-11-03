import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';

// 语义压缩工具的输入参数接口
interface SemanticCompressionInput {
  text: string;
  targetLength: number;
  preserveKeywords?: string[];
}

// 语义压缩工具的输出结果接口
interface SemanticCompressionOutput {
  compressedText: string;
  originalLength: number;
  compressedLength: number;
  compressionRatio: number;
  preservedKeywords: string[];
}

interface WordScore {
  word: string;
  frequency: number;
  importance: number;
  position: number;
}

export class SemanticCompressor extends BaseTool {
  name = 'semantic_compressor';
  
  metadata = {
    name: 'semantic_compressor',
    category: 'text-processing',
    description: '基于语义的文本压缩工具，能够将长文本压缩至指定长度，同时保持核心语义信息',
    version: '1.0.0'
  };

  openaiSchema = {
    type: 'function' as const,
    function: {
      name: 'semantic_compressor',
      description: '基于语义的文本压缩工具，能够将长文本压缩至指定长度，同时保持核心语义信息',
      parameters: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string' as const,
            description: '需要压缩的原始文本'
          },
          targetLength: {
            type: 'number' as const,
            description: '目标压缩长度（字符数）',
            minimum: 1
          },
          preserveKeywords: {
            type: 'array' as const,
            items: {
              type: 'string' as const
            },
            description: '需要在压缩过程中优先保留的关键词列表（可选）',
            default: []
          }
        },
        required: ['text', 'targetLength']
      }
    }
  };

  private stopwords: Set<string> = new Set();

  constructor() {
    super();
    this.initializeStopwords();
  }

  /**
   * 初始化停用词
   */
  private initializeStopwords(): void {
    // 使用内置停用词列表，避免文件系统依赖
    const defaultStopwords = [
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这',
      '他', '她', '它', '们', '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些', '这里', '那里', '现在', '以前', '以后', '今天', '明天', '昨天',
      '可以', '应该', '必须', '需要', '想要', '希望', '觉得', '认为', '知道', '了解', '明白', '清楚', '发现', '找到', '得到', '拿到', '收到', '接到',
      '但是', '然后', '因为', '所以', '如果', '虽然', '尽管', '无论', '不管', '除了', '包括', '关于', '对于', '根据', '按照', '通过', '经过', '由于',
      '什么', '怎么', '为什么', '哪里', '哪个', '哪些', '多少', '几个', '第一', '第二', '第三', '最后', '首先', '其次', '然后', '最终', '总之', '因此'
    ];
    this.stopwords = new Set(defaultStopwords);
  }

  /**
   * 添加自定义停用词
   */
  public addStopwords(words: string[]): void {
    words.forEach(word => this.stopwords.add(word));
  }

  /**
   * 移除停用词
   */
  public removeStopwords(words: string[]): void {
    words.forEach(word => this.stopwords.delete(word));
  }

  private segmentText(text: string): string[] {
    // 简单的中文分词实现
    // 按照标点符号、空格、数字字母分割
    const segments: string[] = [];
    const regex = /[\u4e00-\u9fff]+|[a-zA-Z]+|[0-9]+/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      const segment = match[0];
      if (segment.length > 0) {
        // 对于中文，进一步按常见词汇边界分割
        if (/[\u4e00-\u9fff]/.test(segment)) {
          segments.push(...this.simpleChineseSegment(segment));
        } else {
          segments.push(segment);
        }
      }
    }
    
    return segments;
  }

  /**
   * 简单的中文分词
   */
  private simpleChineseSegment(text: string): string[] {
    const segments: string[] = [];
    let current = '';
    
    for (let i = 0; i < text.length; i++) {
      current += text[i];
      
      // 如果当前字符组合是停用词或常见词汇，则分割
      if (this.stopwords.has(current) || current.length >= 4) {
        segments.push(current);
        current = '';
      }
    }
    
    if (current) {
      segments.push(current);
    }
    
    return segments.filter(seg => seg.length > 0);
  }

  private calculateWordImportance(words: string[], preserveKeywords: string[] = []): WordScore[] {
    const wordFreq = new Map<string, number>();
    const wordPositions = new Map<string, number[]>();
    
    // 统计词频和位置
    words.forEach((word, index) => {
      if (word.trim() && !this.stopwords.has(word)) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        if (!wordPositions.has(word)) {
          wordPositions.set(word, []);
        }
        wordPositions.get(word)!.push(index);
      }
    });

    const maxFreq = Math.max(...Array.from(wordFreq.values()));
    const totalWords = words.length;

    const wordScores: WordScore[] = [];
    
    wordFreq.forEach((freq, word) => {
      const positions = wordPositions.get(word) || [];
      const avgPosition = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
      
      // 计算重要性分数
      let importance = freq / maxFreq; // 频率权重
      
      // 位置权重：开头和结尾的词更重要
      const positionWeight = Math.max(
        1 - (avgPosition / totalWords), // 越靠前越重要
        avgPosition / totalWords > 0.8 ? 0.8 : 0 // 结尾部分也重要
      );
      importance += positionWeight * 0.3;
      
      // 长度权重：较长的词通常更重要
      const lengthWeight = Math.min(word.length / 10, 1);
      importance += lengthWeight * 0.2;
      
      // 保留关键词权重
      if (preserveKeywords.includes(word)) {
        importance += 1.0;
      }
      
      wordScores.push({
        word,
        frequency: freq,
        importance,
        position: avgPosition
      });
    });

    return wordScores.sort((a, b) => b.importance - a.importance);
  }

  private extractKeyPhrases(text: string, wordScores: WordScore[], targetLength: number): string {
    const sentences = text.split(/[。！？；\n]/).filter(s => s.trim());
    const sentenceScores = new Map<string, number>();
    
    // 为每个句子计算分数
    sentences.forEach(sentence => {
      const sentenceWords = this.segmentText(sentence);
      let score = 0;
      let wordCount = 0;
      
      sentenceWords.forEach(word => {
        const wordScore = wordScores.find(ws => ws.word === word);
        if (wordScore) {
          score += wordScore.importance;
          wordCount++;
        }
      });
      
      // 平均分数，避免长句子占优势
      const avgScore = wordCount > 0 ? score / wordCount : 0;
      sentenceScores.set(sentence.trim(), avgScore);
    });

    // 按分数排序句子
    const sortedSentences = Array.from(sentenceScores.entries())
      .sort((a, b) => b[1] - a[1]);

    // 选择句子直到达到目标长度
    let result = '';
    let currentLength = 0;
    
    for (const [sentence, score] of sortedSentences) {
      if (currentLength + sentence.length <= targetLength) {
        result += sentence + '。';
        currentLength += sentence.length + 1;
      } else if (currentLength < targetLength * 0.8) {
        // 如果还没达到目标长度的80%，尝试截取部分句子
        const remainingLength = targetLength - currentLength - 1;
        if (remainingLength > 10) {
          result += sentence.substring(0, remainingLength) + '...';
          break;
        }
      } else {
        break;
      }
    }

    return result.trim();
  }

  async execute(input: SemanticCompressionInput): Promise<ToolResult> {
    try {
      this.validateArgs(input, ['text', 'targetLength']);
      
      const { text, targetLength, preserveKeywords = [] } = input;
      
      if (text.length <= targetLength) {
        return {
         success: true,
         data: {
           compressedText: text,
           originalLength: text.length,
           compressedLength: text.length,
           compressionRatio: 0,
           preservedKeywords: preserveKeywords
         }
       };
      }

      // 分词
      const words = this.segmentText(text);
      this.log(`原文本长度: ${text.length} 字符，分词结果: ${words.length} 个词`);
      
      // 计算词重要性
      const wordScores = this.calculateWordImportance(words, preserveKeywords);
      
      // 提取关键短语和句子
      const compressedText = this.extractKeyPhrases(text, wordScores, targetLength);
      
      const compressionRatio = compressedText.length / text.length;
      
      this.log(`压缩完成: ${text.length} -> ${compressedText.length} 字符 (压缩比: ${(compressionRatio * 100).toFixed(1)}%)`);
      
      return {
         success: true,
         data: {
           compressedText,
           originalLength: text.length,
           compressedLength: compressedText.length,
           compressionRatio: parseFloat(((1 - compressedText.length / text.length) * 100).toFixed(2)),
           preservedKeywords: preserveKeywords
         }
       };
      
    } catch (error) {
      return {
         success: false,
         error: error instanceof Error ? error.message : '语义压缩过程中发生未知错误'
       };
    }
  }
}