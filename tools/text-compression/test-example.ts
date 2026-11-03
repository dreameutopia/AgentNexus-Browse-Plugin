/**
 * 语义压缩工具测试示例
 */

import { SemanticCompressor } from './semantic-compressor';

// 创建工具实例
const compressor = new SemanticCompressor();

// 测试用例
const testCases = [
  {
    name: '长文本压缩测试',
    text: `人工智能是计算机科学的一个分支，它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式做出反应的智能机器。该领域的研究包括机器人、语言识别、图像识别、自然语言处理和专家系统等。人工智能从诞生以来，理论和技术日益成熟，应用领域也不断扩大，可以设想，未来人工智能带来的科技产品，将会是人类智慧的"容器"。人工智能可以对人的意识、思维的信息过程的模拟。人工智能不是人的智能，但能像人那样思考、也可能超过人的智能。`,
    targetLength: 100,
    preserveKeywords: ['人工智能', '机器学习']
   },
   {
     name: '技术文档压缩测试',
     text: `Vue.js是一套用于构建用户界面的渐进式JavaScript框架。与其它大型框架不同的是，Vue被设计为可以自底向上逐层应用。Vue的核心库只关注视图层，不仅易于上手，还便于与第三方库或既有项目整合。另一方面，当与现代化的工具链以及各种支持类库结合使用时，Vue也完全能够为复杂的单页应用提供驱动。`,
     targetLength: 80,
     preserveKeywords: ['Vue.js', 'JavaScript']
   }
 ];
 
 // 执行测试的异步函数
 export async function runTests() {
   console.log('开始测试语义压缩工具...');
   
   for (const testCase of testCases) {
     console.log(`\n=== ${testCase.name} ===`);
     console.log('原文长度:', testCase.text.length);
     console.log('目标长度:', testCase.targetLength);
     
     try {
       const result = await compressor.execute({
         text: testCase.text,
         targetLength: testCase.targetLength,
         preserveKeywords: testCase.preserveKeywords
       });
       
       if (result.success) {
         const data = result.data;
         console.log('压缩成功!');
         console.log('压缩后长度:', data.compressedText.length);
         console.log('压缩率:', `${((1 - data.compressedText.length / testCase.text.length) * 100).toFixed(1)}%`);
         console.log('压缩后文本:', data.compressedText);
         console.log('保留的关键词:', data.preservedKeywords);
       } else {
         console.error('压缩失败:', result.error);
       }
     } catch (error) {
       console.error('执行错误:', error);
     }
   }
 }
 
 // 如果直接运行此文件，则执行测试
 if (typeof window === 'undefined') {
   runTests().catch(console.error);
 }