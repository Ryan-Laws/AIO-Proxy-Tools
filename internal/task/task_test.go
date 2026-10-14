package task

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// 调用方一看到任务结束就会提交下一个任务，所以 onEnd（释放服务器占用）必须先于结束状态生效
func TestOnEndRunsBeforeTaskEnds(t *testing.T) {
	m := NewManager(NewBus())
	for i := 0; i < 2000; i++ {
		var busy atomic.Bool
		busy.Store(true)
		tk := m.Start("s", "test", func(ctx context.Context, t *Task) error { return nil },
			func(t *Task, err error) { busy.Store(false) })
		deadline := time.Now().Add(5 * time.Second)
		for {
			v, _ := m.Get(tk.ID())
			if v.State != "running" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("任务没有结束")
			}
		}
		if busy.Load() {
			t.Fatalf("第 %d 次：任务已结束，但 onEnd 还没执行", i)
		}
	}
}
