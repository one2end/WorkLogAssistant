const fs = require('fs');
const path = require('path');

class OCRManager {
  constructor() {
    this.ocrDir = path.join(__dirname, '../Data/ocr');
    this.ensureOCRDir();
  }

  ensureOCRDir() {
    if (!fs.existsSync(this.ocrDir)) {
      fs.mkdirSync(this.ocrDir, { recursive: true });
    }
  }

  async recognizeImage(imagePath) {
    try {
      return {
        text: 'OCR功能开发中...\n\n目前OCR功能正在完善中，将在后续版本中提供完整的Windows OCR支持。\n\n感谢您的理解！',
        success: false,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('OCR识别失败:', error);
      return {
        text: 'OCR功能开发中...',
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async saveOCRResult(activityId, ocrResult) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `ocr_${activityId}_${timestamp}.json`;
      const filepath = path.join(this.ocrDir, filename);
      
      const data = JSON.stringify(ocrResult, null, 2);
      fs.writeFileSync(filepath, data, 'utf8');
      
      return filepath;
    } catch (error) {
      console.error('保存OCR结果失败:', error);
      return null;
    }
  }

  getOCRResult(activityId) {
    try {
      const files = fs.readdirSync(this.ocrDir);
      const ocrFile = files.find(file => file.startsWith(`ocr_${activityId}_`));
      
      if (ocrFile) {
        const filepath = path.join(this.ocrDir, ocrFile);
        const data = fs.readFileSync(filepath, 'utf8');
        return JSON.parse(data);
      }
      
      return null;
    } catch (error) {
      console.error('获取OCR结果失败:', error);
      return null;
    }
  }

  deleteOldOCR(daysToKeep = 30) {
    try {
      const files = fs.readdirSync(this.ocrDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      files.forEach(file => {
        const filepath = path.join(this.ocrDir, file);
        const stats = fs.statSync(filepath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filepath);
          console.log(`删除过期OCR结果: ${file}`);
        }
      });
    } catch (error) {
      console.error('清理过期OCR结果失败:', error);
    }
  }
}

module.exports = OCRManager;
